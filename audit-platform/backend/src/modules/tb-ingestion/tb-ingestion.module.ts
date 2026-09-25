import { existsSync } from 'node:fs';
import path from 'node:path';
import { Inject, Module, type DynamicModule, type OnModuleInit } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { decodeSecret, type AppConfig } from '../../config/config.js';
import type { TenantDb } from '../../database/tenant-db.js';
import { JobEnvelopeCodec } from '../../jobs/job-envelope.js';
import { InProcessJobQueue } from '../../jobs/job-queue.js';
import { InMemoryObjectStore } from '../../storage/in-memory-object-store.js';
import { TenantObjectStore, type ObjectStorePort } from '../../storage/tenant-object-store.js';
import { APP_CONFIG, PG_POOL, TENANT_DB } from '../../tenancy/tokens.js';
import { ClaudeAccountClassifier, type AccountClassifierPort } from './llm-classifier.js';
import type { TbParserPort } from './parser-port.js';
import { SubprocessTbParser } from './subprocess-parser.js';
import { TbIngestionController } from './tb-ingestion.controller.js';
import { PgServicePrincipals, TB_IMPORT_JOB, TbImportWorker } from './tb-import.worker.js';
import { ACCOUNT_CLASSIFIER, INGESTION_SETTINGS, JOB_CODEC, JOB_QUEUE, TB_IMPORT_WORKER, TB_OBJECT_STORE, TB_PARSER } from './tokens.js';

export interface TbIngestionOptions {
  /** Replace the sandboxed parser (tests). */
  parser?: TbParserPort;
  /** Replace the object store port (tests inspect stored objects). */
  objectStorePort?: ObjectStorePort;
  /** Replace the LLM classifier; `null` disables the stage regardless of configuration. */
  classifier?: AccountClassifierPort | null;
  /** Receives structured worker events (no file contents). */
  log?: (event: Record<string, unknown>) => void;
}

function defaultParser(c: AppConfig): TbParserPort {
  const dir = path.resolve(c.TB_PARSER_DIR);
  const venv = path.join(dir, '.venv', 'bin', 'python');
  const python = c.TB_PARSER_PYTHON ?? (existsSync(venv) ? venv : 'python3');
  return new SubprocessTbParser({ python, cwd: dir, timeoutMs: c.TB_PARSER_TIMEOUT_MS });
}

function defaultClassifier(c: AppConfig): AccountClassifierPort | null {
  if (!c.MAPPING_LLM_ENABLED) return null;
  // Credentials resolve from the environment (ANTHROPIC_API_KEY or equivalent); never from config files.
  return new ClaudeAccountClassifier({ client: new Anthropic(), model: c.MAPPING_LLM_MODEL, effort: c.MAPPING_LLM_EFFORT });
}

/*
 * Upload -> sandboxed parse -> TB + lines (control totals re-verified in-DB)
 * -> deterministic cascade (+ optional LLM) -> suggestions -> human review -> lock.
 */
@Module({})
export class TbIngestionModule implements OnModuleInit {
  constructor(
    @Inject(JOB_QUEUE) private readonly queue: InProcessJobQueue,
    @Inject(TB_IMPORT_WORKER) private readonly worker: TbImportWorker,
  ) {}

  onModuleInit(): void {
    this.queue.register(TB_IMPORT_JOB, async (envelope) => { await this.worker.handle(envelope); });
  }

  static forRoot(options: TbIngestionOptions = {}): DynamicModule {
    return {
      module: TbIngestionModule,
      controllers: [TbIngestionController],
      providers: [
        { provide: TB_PARSER, inject: [APP_CONFIG], useFactory: (c: AppConfig) => options.parser ?? defaultParser(c) },
        {
          provide: TB_OBJECT_STORE,
          inject: [APP_CONFIG],
          useFactory: (c: AppConfig) => new TenantObjectStore(
            options.objectStorePort ?? new InMemoryObjectStore(), c.TB_SOURCE_BUCKET,
            // Per-tenant CMK alias; the S3/KMS adapter resolves it (sovereign tenants: XKS-backed key).
            (tenantId) => `alias/audit-tenant-${tenantId}`),
        },
        { provide: JOB_CODEC, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new JobEnvelopeCodec(decodeSecret(c.JOB_ENVELOPE_KEY)) },
        {
          provide: JOB_QUEUE,
          useFactory: () => new InProcessJobQueue((err) => {
            console.error(JSON.stringify({ level: 'error', event: 'job_failed', name: (err as Error)?.name }));
          }),
        },
        {
          provide: ACCOUNT_CLASSIFIER,
          inject: [APP_CONFIG],
          useFactory: (c: AppConfig) => (options.classifier !== undefined ? options.classifier : defaultClassifier(c)),
        },
        { provide: INGESTION_SETTINGS, inject: [APP_CONFIG], useFactory: (c: AppConfig) => ({ maxUploadBytes: c.TB_UPLOAD_MAX_BYTES }) },
        {
          provide: TB_IMPORT_WORKER,
          inject: [TENANT_DB, JOB_CODEC, PG_POOL, TB_OBJECT_STORE, TB_PARSER, ACCOUNT_CLASSIFIER, APP_CONFIG],
          useFactory: (db: TenantDb, codec: JobEnvelopeCodec, pool: pg.Pool, store: TenantObjectStore, parser: TbParserPort,
                       classifier: AccountClassifierPort | null, c: AppConfig) =>
            new TbImportWorker(db, codec, new PgServicePrincipals(pool), store, parser, classifier,
              { llmBatchSize: c.MAPPING_LLM_BATCH_SIZE, ...(options.log ? { log: options.log } : {}) }),
        },
      ],
      exports: [JOB_QUEUE, TB_OBJECT_STORE],
    };
  }
}
