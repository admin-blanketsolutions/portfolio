import { randomUUID, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { DomainError } from '../../common/errors.js';
import type { TenantDb } from '../../database/tenant-db.js';
import type { JobEnvelopeCodec } from '../../jobs/job-envelope.js';
import type { JobQueue } from '../../jobs/job-queue.js';
import type { TenantObjectStore } from '../../storage/tenant-object-store.js';
import { Ctx } from '../../tenancy/decorators.js';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import { TENANT_DB } from '../../tenancy/tokens.js';
import { blocksBulkAccept, concentratedAccounts, mappingFlags, nameFlags } from './flags.js';
import { normalizeCode, normalizeForMatching } from './normalize.js';
import { TB_IMPORT_JOB } from './tb-import.worker.js';
import { TbIngestionRepository, type ImportRow } from './tb-ingestion.repository.js';
import { INGESTION_SETTINGS, JOB_CODEC, JOB_QUEUE, TB_OBJECT_STORE, type IngestionSettings } from './tokens.js';
import { receiveUpload } from './upload.js';

const Uuid = z.uuid();
const UploadQuery = z.object({
  filename: z.string().min(1).max(1024),
  kind: z.enum(['current_unadjusted', 'prior_year_final']).default('current_unadjusted'),
  asOfDate: z.iso.date().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
});
const LinesQuery = z.object({
  afterLine: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const AcceptBody = z.object({ acknowledgeFlags: z.boolean().default(false) }).default({ acknowledgeFlags: false });
const BulkAcceptBody = z.object({ mappingIds: z.array(Uuid).min(1).max(500) });
const ManualBody = z.object({
  coaCode: z.string().min(1).max(20),
  rationale: z.string().trim().min(3).max(1000),
});
const RuleBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('code_prefix'), pattern: z.string().min(1).max(64), priority: z.number().int().min(0).max(100000), coaCode: z.string().min(1).max(20), description: z.string().max(500).optional() }),
  z.object({ kind: z.literal('code_range'), pattern: z.string().min(1).max(64), patternTo: z.string().min(1).max(64), priority: z.number().int().min(0).max(100000), coaCode: z.string().min(1).max(20), description: z.string().max(500).optional() }),
  z.object({ kind: z.literal('name_contains'), pattern: z.string().min(1).max(128), priority: z.number().int().min(0).max(100000), coaCode: z.string().min(1).max(20), description: z.string().max(500).optional() }),
]);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new DomainError('invalid', 'Malformed request.');
  return r.data;
}

function notFound(): never {
  // RLS makes other tenants' and walled engagements' rows invisible: same answer as "does not exist".
  throw new DomainError('not_found', 'Not found.');
}

function importView(i: ImportRow) {
  return {
    id: i.id, engagementId: i.engagementId, status: i.status, kind: i.tbKind, asOfDate: i.asOfDate, currency: i.currency,
    filename: i.sourceFilename, format: i.sourceFormat, sizeBytes: i.sourceSizeBytes, sha256: i.sourceSha256Hex,
    trialBalanceId: i.trialBalanceId, parserVersion: i.parserVersion,
    failure: i.failureCode ? { code: i.failureCode, message: i.failureMessage } : null,
    report: i.report ?? null, mappingSummary: i.mappingSummary ?? null, createdAt: i.createdAt, completedAt: i.completedAt,
  };
}

@Controller()
export class TbIngestionController {
  private readonly repo = new TbIngestionRepository();

  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    @Inject(TB_OBJECT_STORE) private readonly store: TenantObjectStore,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(JOB_CODEC) private readonly codec: JobEnvelopeCodec,
    @Inject(INGESTION_SETTINGS) private readonly settings: IngestionSettings,
  ) {}

  // ---------------------------------------------------------------------------
  // Upload & import status
  // ---------------------------------------------------------------------------
  /**
   * Raw body upload: `POST /engagements/:id/tb-imports?filename=TB%202025.xlsx`
   * with Content-Type xlsx / text/csv. Responds 202; poll the import.
   */
  @Post('engagements/:id/tb-imports')
  @HttpCode(202)
  async upload(@Param('id') id: string, @Query() query: unknown, @Req() req: IncomingMessage, @Ctx() ctx: TenantContext) {
    const engagementId = parse(Uuid, id);
    const q = parse(UploadQuery, query);
    if (ctx.kind !== 'staff') throw new DomainError('forbidden', 'You are not permitted to perform this action.');
    const file = await receiveUpload(req, q.filename, this.settings.maxUploadBytes);
    const digest = createHash('sha256').update(file.bytes).digest();
    const importId = randomUUID();

    const row = await this.db.transaction(async (tx) => {
      const eng = await this.repo.engagementDefaults(tx, engagementId);
      if (!eng) notFound();
      const retainUntil = new Date();
      retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + (await this.repo.retentionYears(tx)));
      const key = this.store.tbSourceKey(engagementId, importId);
      // The row first: RLS, the archive lock and the staff-only rule refuse
      // before anything is written to WORM storage.
      const inserted = await this.repo.insertImport(tx, {
        id: importId, engagementId, tbKind: q.kind, asOfDate: q.asOfDate ?? eng.periodEnd, currency: q.currency ?? eng.currency,
        sourceObjectKey: key, sourceSha256Hex: digest.toString('hex'), sourceFilename: file.filename,
        sourceFormat: file.format, sourceSizeBytes: file.bytes.length,
      });
      await this.store.putTbSource({
        engagementId, importId, bytes: file.bytes, sha256Base64: digest.toString('base64'),
        contentType: file.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
        retainUntil,
      });
      return inserted;
    });
    await this.queue.enqueue(this.codec.seal(TB_IMPORT_JOB, { importId }));
    return importView(row);
  }

  @Get('engagements/:id/tb-imports')
  async listImports(@Param('id') id: string) {
    const engagementId = parse(Uuid, id);
    const rows = await this.db.transaction((tx) => this.repo.listImports(tx, engagementId), { readOnly: true });
    return { imports: rows.map(importView) };
  }

  @Get('tb-imports/:id')
  async getImport(@Param('id') id: string) {
    const row = await this.db.transaction((tx) => this.repo.getImport(tx, parse(Uuid, id)), { readOnly: true });
    return row ? importView(row) : notFound();
  }

  // ---------------------------------------------------------------------------
  // Review
  // ---------------------------------------------------------------------------
  @Get('trial-balances/:id')
  async trialBalance(@Param('id') id: string) {
    const tb = await this.db.transaction((tx) => this.repo.trialBalance(tx, parse(Uuid, id)), { readOnly: true });
    return tb ?? notFound();
  }

  @Get('trial-balances/:id/lines')
  async lines(@Param('id') id: string, @Query() query: unknown) {
    const tbId = parse(Uuid, id);
    const { afterLine, limit } = parse(LinesQuery, query);
    return this.db.transaction(async (tx) => {
      const tb = await this.repo.trialBalance(tx, tbId);
      if (!tb) notFound();
      const rows = await this.repo.reviewLines(tx, tbId, afterLine, limit);
      const load = await this.repo.accountLoad(tx, tbId);
      const concentrated = concentratedAccounts(load.counts, load.lines);
      const lines = rows.map((r) => ({
        id: r.id, lineNo: r.line_no, code: r.client_account_code, name: r.client_account_name, closing: r.closing,
        hadFormula: r.source_had_formula,
        flags: nameFlags(r.client_account_name),
        accepted: r.acc_id ? { mappingId: r.acc_id, coaCode: r.acc_code, coaNameEn: r.acc_name_en, source: r.acc_source, decidedBy: r.acc_decided_by } : null,
        suggestion: r.sug_id ? {
          mappingId: r.sug_id, coaCode: r.sug_code, coaNameEn: r.sug_name_en, coaNameAr: r.sug_name_ar, source: r.sug_source,
          confidence: r.sug_confidence, modelRef: r.sug_model_ref, rationale: r.sug_rationale,
          flags: mappingFlags({ name: r.client_account_name, closing: r.closing, normalBalance: r.sug_normal_balance,
                                confidence: r.sug_confidence, concentrated: concentrated.has(r.sug_coa) }),
        } : null,
      }));
      const last = rows.at(-1);
      return { trialBalanceId: tbId, lines, nextAfterLine: rows.length === limit && last ? last.line_no : null };
    }, { readOnly: true, isolation: 'repeatable read' });
  }

  @Post('mappings/:id/accept')
  @HttpCode(200)
  async accept(@Param('id') id: string, @Body() body: unknown) {
    const mappingId = parse(Uuid, id);
    const { acknowledgeFlags } = parse(AcceptBody, body ?? {});
    return this.db.transaction(async (tx) => {
      const s = await this.repo.suggestionForDecision(tx, mappingId);
      if (!s) notFound();
      if (s.status !== 'suggested') throw new DomainError('conflict', 'This suggestion has already been decided.');
      const load = await this.repo.accountLoad(tx, s.trial_balance_id);
      const flags = mappingFlags({ name: s.name, closing: s.closing, normalBalance: s.normal_balance, confidence: s.confidence,
                                   concentrated: concentratedAccounts(load.counts, load.lines).has(s.coa_account_id) });
      if (flags.length > 0 && !acknowledgeFlags) {
        throw new DomainError('conflict', `This suggestion is flagged (${flags.join(', ')}); review it and resend with acknowledgeFlags=true.`);
      }
      await this.repo.accept(tx, mappingId, s.tb_line_id);
      return { mappingId, status: 'accepted', flags };
    });
  }

  @Post('mappings/:id/reject')
  @HttpCode(200)
  async reject(@Param('id') id: string) {
    const mappingId = parse(Uuid, id);
    const ok = await this.db.transaction((tx) => this.repo.reject(tx, mappingId));
    if (!ok) notFound();
    return { mappingId, status: 'rejected' };
  }

  /** Accept many suggestions at once; flagged ones are skipped and must be reviewed individually. */
  @Post('trial-balances/:id/bulk-accept')
  @HttpCode(200)
  async bulkAccept(@Param('id') id: string, @Body() body: unknown) {
    const tbId = parse(Uuid, id);
    const { mappingIds } = parse(BulkAcceptBody, body);
    return this.db.transaction(async (tx) => {
      const load = await this.repo.accountLoad(tx, tbId);
      const concentrated = concentratedAccounts(load.counts, load.lines);
      const accepted: string[] = [];
      const skipped: Array<{ mappingId: string; reason: string; flags?: string[] }> = [];
      for (const mappingId of new Set(mappingIds)) {
        const s = await this.repo.suggestionForDecision(tx, mappingId);
        if (!s || s.trial_balance_id !== tbId) { skipped.push({ mappingId, reason: 'not_found' }); continue; }
        if (s.status !== 'suggested') { skipped.push({ mappingId, reason: 'not_pending' }); continue; }
        const flags = mappingFlags({ name: s.name, closing: s.closing, normalBalance: s.normal_balance,
                                     confidence: s.confidence, concentrated: concentrated.has(s.coa_account_id) });
        if (blocksBulkAccept(flags)) { skipped.push({ mappingId, reason: 'flagged', flags }); continue; }
        await this.repo.accept(tx, mappingId, s.tb_line_id);
        accepted.push(mappingId);
      }
      return { accepted, skipped };
    });
  }

  @Post('trial-balances/:id/lines/:lineId/mapping')
  @HttpCode(201)
  async manual(@Param('id') id: string, @Param('lineId') lineId: string, @Body() body: unknown) {
    const tbId = parse(Uuid, id);
    const line = parse(Uuid, lineId);
    const { coaCode, rationale } = parse(ManualBody, body);
    return this.db.transaction(async (tx) => {
      const l = await this.repo.lineOfTrialBalance(tx, tbId, line);
      if (!l) notFound();
      const coaId = await this.repo.accountIdByCode(tx, coaCode);
      if (!coaId) throw new DomainError('invalid', 'Unknown chart-of-accounts code.');
      const mappingId = await this.repo.manualMapping(tx, l.engagementId, tbId, line, coaId, rationale);
      return { mappingId, status: 'accepted', source: 'manual' };
    });
  }

  @Post('trial-balances/:id/lock')
  @HttpCode(200)
  async lock(@Param('id') id: string) {
    const tbId = parse(Uuid, id);
    const r = await this.db.transaction((tx) => this.repo.lock(tx, tbId));
    if (!r) throw new DomainError('not_found', 'No imported (unlocked) trial balance with this id.');
    return { trialBalanceId: tbId, status: 'locked', lockedAt: r.lockedAt };
  }

  // ---------------------------------------------------------------------------
  // Chart of accounts & firm rules
  // ---------------------------------------------------------------------------
  @Get('coa')
  async coa(@Query('postable') postable?: string) {
    const accounts = await this.db.transaction((tx) => this.repo.chartOfAccounts(tx, postable === 'true'), { readOnly: true });
    return { accounts };
  }

  @Get('mapping-rules')
  async rules() {
    return { rules: await this.db.transaction((tx) => this.repo.listRules(tx), { readOnly: true }) };
  }

  @Post('mapping-rules')
  @HttpCode(201)
  async createRule(@Body() body: unknown) {
    const b = parse(RuleBody, body);
    const pattern = b.kind === 'name_contains' ? normalizeForMatching(b.pattern) : normalizeCode(b.pattern);
    const patternTo = b.kind === 'code_range' ? normalizeCode(b.patternTo) : null;
    if (!pattern) throw new DomainError('invalid', 'The pattern is empty after normalisation.');
    const id = await this.db.transaction(async (tx) => {
      const coaId = await this.repo.accountIdByCode(tx, b.coaCode);
      if (!coaId) throw new DomainError('invalid', 'Unknown chart-of-accounts code.');
      return this.repo.insertRule(tx, { priority: b.priority, kind: b.kind, pattern, patternTo, coaId, description: b.description ?? null });
    });
    return { id };
  }

  @Post('mapping-rules/:id/deactivate')
  @HttpCode(200)
  async deactivateRule(@Param('id') id: string) {
    const ok = await this.db.transaction((tx) => this.repo.deactivateRule(tx, parse(Uuid, id)));
    if (!ok) notFound();
    return { id, isActive: false };
  }
}
