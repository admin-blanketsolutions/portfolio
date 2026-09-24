import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { DomainError } from '../../common/errors.js';
import type { TenantDb } from '../../database/tenant-db.js';
import type { JobEnvelope, JobEnvelopeCodec } from '../../jobs/job-envelope.js';
import type { TenantObjectStore } from '../../storage/tenant-object-store.js';
import { runWithTenantContext, withoutTenantContext, type TenantContext } from '../../tenancy/tenant-context.js';
import type { AccountClassifierPort, ClassifierLine } from './llm-classifier.js';
import { deterministicSuggestions, type Suggestion } from './mapping-engine.js';
import { TbParseRejected, type ParseResult, type TbParserPort } from './parser-port.js';
import { TbIngestionRepository, type ImportRow } from './tb-ingestion.repository.js';

export const TB_IMPORT_JOB = 'tb.import';
export const INGESTION_PRINCIPAL = 'system:tb-ingestion';

const Payload = z.object({ importId: z.uuid() });

export interface ServicePrincipalLookup {
  servicePrincipalId(tenantId: string, subject: string): Promise<string | null>;
}

/** Pre-context lookup through the narrow SECURITY DEFINER function of V0010. */
export class PgServicePrincipals implements ServicePrincipalLookup {
  constructor(private readonly pool: pg.Pool) {}

  async servicePrincipalId(tenantId: string, subject: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string | null }>(
      'SELECT platform.service_principal_id($1, $2) AS id', [tenantId, subject]);
    return rows[0]?.id ?? null;
  }
}

export interface MappingSummary {
  suggested: Record<string, number>;
  unmatched: number;
  llm: 'disabled' | 'not_permitted_for_tenant' | 'nothing_to_do' | 'ran';
  llmSkippedBatches?: Record<string, number>;
  llmErrors?: number;
  error?: string;
}

export interface WorkerOptions {
  llmBatchSize: number;
  log?: (event: Record<string, unknown>) => void;
}

export type ImportOutcome = 'imported' | 'failed' | 'skipped';

/**
 * Processes one uploaded TB file.
 *
 * Identity: the envelope is sealed with the UPLOADER's context. After verifying
 * it, the worker acts as the tenant's ingestion service principal, and only
 * for the one import the envelope names, and only if that import was created
 * by that uploader and is still `received`. Writing lines and suggestions as
 * a service principal lets the database distinguish machine output from human
 * decisions (V0010): the principal can suggest but can never accept.
 */
export class TbImportWorker {
  private readonly repo = new TbIngestionRepository();

  constructor(
    private readonly db: TenantDb,
    private readonly codec: JobEnvelopeCodec,
    private readonly principals: ServicePrincipalLookup,
    private readonly store: TenantObjectStore,
    private readonly parser: TbParserPort,
    private readonly classifier: AccountClassifierPort | null,
    private readonly opts: WorkerOptions,
  ) {}

  async handle(envelope: JobEnvelope<unknown>): Promise<ImportOutcome> {
    const uploader = this.codec.open(envelope);          // MAC + expiry; throws on forgery
    const { importId } = Payload.parse(envelope.payload);
    if (envelope.type !== TB_IMPORT_JOB || uploader.kind !== 'staff') return 'skipped';
    const serviceId = await this.principals.servicePrincipalId(uploader.tenantId, INGESTION_PRINCIPAL);
    if (!serviceId) throw new Error('tenant has no active ingestion principal');
    const service: TenantContext = { ...uploader, userId: serviceId, kind: 'service', isFirmAdmin: false };
    return withoutTenantContext(() => runWithTenantContext(service, () => this.process(importId, uploader.userId)));
  }

  private async process(importId: string, uploaderId: string): Promise<ImportOutcome> {
    const imp = await this.db.transaction(async (tx) => {
      const row = await this.repo.getImport(tx, importId, true);
      if (!row || row.createdBy !== uploaderId || row.status !== 'received') return null;
      await this.repo.markProcessing(tx, importId);
      return row;
    });
    if (!imp) {
      this.log({ event: 'tb_import', importId, outcome: 'skipped' });
      return 'skipped';
    }

    let result: ParseResult;
    try {
      const bytes = await this.store.getOwn(imp.sourceObjectKey);
      if (createHash('sha256').update(bytes).digest('hex') !== imp.sourceSha256Hex) {
        throw new TbParseRejected('source_integrity', 'The stored file does not match the checksum recorded at upload.');
      }
      result = await this.parser.parse({ bytes, format: imp.sourceFormat });
    } catch (err) {
      const rejected = err instanceof TbParseRejected;
      await this.fail(imp, rejected ? err.code : 'internal_error',
        rejected ? err.message : 'The file could not be processed. Please try again later.', err);
      return 'failed';
    }

    let tbId: string;
    try {
      tbId = await this.db.transaction(async (tx) => {
        const tb = await this.repo.buildTrialBalance(tx, imp, result);
        await this.repo.markImported(tx, imp.id, tb.id, result.parser_version, reportOf(result));
        return tb.id;
      });
    } catch (err) {
      // Messages of our own triggers (control totals, closed engagement) are written for users.
      const userFacing = err instanceof DomainError && (err.code === 'invalid' || err.code === 'conflict');
      await this.fail(imp, 'import_rejected',
        userFacing ? (err as DomainError).message : 'The trial balance could not be stored.', err);
      return 'failed';
    }

    let summary: MappingSummary;
    try {
      summary = await this.suggest(imp.engagementId, tbId);
    } catch (err) {
      this.log({ event: 'tb_mapping_error', importId, error: (err as Error)?.name });
      summary = { suggested: {}, unmatched: result.lines.length, llm: 'disabled', error: 'mapping_failed' };
    }
    await this.db.transaction((tx) => this.repo.setMappingSummary(tx, imp.id, summary));
    this.log({ event: 'tb_import', importId, outcome: 'imported', lines: result.lines.length });
    return 'imported';
  }

  /** Runs the cascade for every line that has no live suggestion or acceptance yet. */
  private async suggest(engagementId: string, tbId: string): Promise<MappingSummary> {
    const input = await this.db.transaction(async (tx) => ({
      lines: await this.repo.unmappedLines(tx, tbId),
      coa: await this.repo.postableAccounts(tx),
      rules: await this.repo.activeRules(tx),
      history: await this.repo.clientHistory(tx, engagementId, tbId),
      llmAllowed: await this.repo.llmAllowedForTenant(tx),
    }), { readOnly: true, isolation: 'repeatable read' });

    const det = deterministicSuggestions(input.lines, input.coa, input.rules, input.history);
    if (det.suggestions.length > 0) {
      await this.db.transaction((tx) => this.repo.insertSuggestions(tx, engagementId, tbId, det.suggestions));
    }
    const summary: MappingSummary = { suggested: countBySource(det.suggestions), unmatched: det.residual.length, llm: 'disabled' };

    if (!this.classifier) return summary;
    if (!input.llmAllowed) return { ...summary, llm: 'not_permitted_for_tenant' };
    if (det.residual.length === 0) return { ...summary, llm: 'nothing_to_do' };

    const accounts = input.coa.map((c) => ({ code: c.code, nameEn: c.nameEn, nameAr: c.nameAr, accountClass: c.accountClass, normalBalance: c.normalBalance }));
    const idByCode = new Map(input.coa.map((c) => [c.code, c.id]));
    const skipped: Record<string, number> = {};
    let errors = 0;
    let llmCount = 0;
    for (let i = 0; i < det.residual.length; i += this.opts.llmBatchSize) {
      const batch = det.residual.slice(i, i + this.opts.llmBatchSize);
      // Batch-local references: no database ids leave the platform.
      const byRef = new Map(batch.map((l, j) => [`L${j + 1}`, l]));
      const lines: ClassifierLine[] = [...byRef].map(([ref, l]) => ({
        ref, code: l.code, name: l.name, side: l.closing.startsWith('-') ? 'credit' : Number(l.closing) === 0 ? 'zero' : 'debit',
      }));
      try {
        const res = await this.classifier.classify(accounts, lines);
        if (res.skipped) skipped[res.skipped] = (skipped[res.skipped] ?? 0) + 1;
        const suggestions: Suggestion[] = res.suggestions.flatMap((s) => {
          const line = byRef.get(s.ref);
          const coaId = idByCode.get(s.coaCode);
          return line && coaId ? [{ lineId: line.id, coaAccountId: coaId, source: 'llm' as const, confidence: s.confidence, modelRef: res.modelRef, rationale: s.rationale }] : [];
        });
        if (suggestions.length > 0) {
          await this.db.transaction((tx) => this.repo.insertSuggestions(tx, engagementId, tbId, suggestions));
          llmCount += suggestions.length;
        }
      } catch (err) {
        errors += 1;
        this.log({ event: 'tb_llm_error', error: (err as Error)?.name, status: (err as { status?: number })?.status });
      }
    }
    return {
      ...summary,
      suggested: { ...summary.suggested, ...(llmCount ? { llm: llmCount } : {}) },
      unmatched: det.residual.length - llmCount,
      llm: 'ran',
      ...(Object.keys(skipped).length ? { llmSkippedBatches: skipped } : {}),
      ...(errors ? { llmErrors: errors } : {}),
    };
  }

  private async fail(imp: ImportRow, code: string, message: string, err: unknown): Promise<void> {
    this.log({ event: 'tb_import', importId: imp.id, outcome: 'failed', code, error: (err as Error)?.name });
    await this.db.transaction((tx) => this.repo.markFailed(tx, imp.id, code, message));
  }

  private log(event: Record<string, unknown>): void {
    this.opts.log?.({ level: 'info', ...event });
  }
}

function countBySource(suggestions: readonly Suggestion[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of suggestions) out[s.source] = (out[s.source] ?? 0) + 1;
  return out;
}

/** What is kept of the parse result besides the lines: shape, totals, warnings (never cell contents). */
function reportOf(r: ParseResult) {
  return { format: r.format, sheet: r.sheet, headerRow: r.header_row, layout: r.layout, columns: r.columns,
           control: r.control, warnings: r.warnings };
}
