import type { TenantTx } from '../../database/tenant-db.js';
import type { CoaOption, EngineLine, HistoryHit, MappingRule, Suggestion } from './mapping-engine.js';
import type { ParseResult } from './parser-port.js';

/*
 * SQL for TB ingestion. As everywhere, authorisation is RLS + triggers: the
 * same statement returns nothing (or fails) for a user outside the
 * engagement's team or another tenant. Amounts stay strings end to end.
 */

export type TbKind = 'current_unadjusted' | 'prior_year_final';
export type ImportStatus = 'received' | 'processing' | 'imported' | 'failed';

export interface ImportRow {
  id: string;
  engagementId: string;
  tbKind: TbKind;
  asOfDate: string;
  currency: string;
  sourceObjectKey: string;
  sourceSha256Hex: string;
  sourceFilename: string;
  sourceFormat: 'csv' | 'xlsx';
  sourceSizeBytes: number;
  status: ImportStatus;
  trialBalanceId: string | null;
  parserVersion: string | null;
  report: unknown;
  failureCode: string | null;
  failureMessage: string | null;
  mappingSummary: unknown;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

const IMPORT_COLUMNS = `i.id, i.engagement_id, i.tb_kind, i.as_of_date::text, i.currency, i.source_object_key,
  encode(i.source_sha256, 'hex') AS sha, i.source_filename, i.source_format, i.source_size_bytes, i.status,
  i.trial_balance_id, i.parser_version, i.report, i.failure_code, i.failure_message, i.mapping_summary,
  i.created_by, i.created_at::text, i.completed_at::text`;

function toImport(r: Record<string, any>): ImportRow {
  return {
    id: r.id, engagementId: r.engagement_id, tbKind: r.tb_kind, asOfDate: r.as_of_date, currency: r.currency,
    sourceObjectKey: r.source_object_key, sourceSha256Hex: r.sha, sourceFilename: r.source_filename,
    sourceFormat: r.source_format, sourceSizeBytes: Number(r.source_size_bytes), status: r.status,
    trialBalanceId: r.trial_balance_id, parserVersion: r.parser_version, report: r.report,
    failureCode: r.failure_code, failureMessage: r.failure_message, mappingSummary: r.mapping_summary,
    createdBy: r.created_by, createdAt: r.created_at, completedAt: r.completed_at,
  };
}

export interface NewImport {
  id: string;
  engagementId: string;
  tbKind: TbKind;
  asOfDate: string;
  currency: string;
  sourceObjectKey: string;
  sourceSha256Hex: string;
  sourceFilename: string;
  sourceFormat: 'csv' | 'xlsx';
  sourceSizeBytes: number;
}

const LINE_CHUNK = 2_000;

export class TbIngestionRepository {
  // ---------------------------------------------------------------------------
  // Uploads (human context)
  // ---------------------------------------------------------------------------
  async engagementDefaults(tx: TenantTx, engagementId: string): Promise<{ periodEnd: string; currency: string } | null> {
    const { rows } = await tx.query<{ period_end: string; reporting_currency: string }>(
      'SELECT period_end::text, reporting_currency FROM app.engagements WHERE id = $1', [engagementId]);
    return rows[0] ? { periodEnd: rows[0].period_end, currency: rows[0].reporting_currency } : null;
  }

  async retentionYears(tx: TenantTx): Promise<number> {
    const { rows } = await tx.query<{ y: number }>(
      'SELECT record_retention_years AS y FROM platform.tenants WHERE id = app.current_tenant_id()');
    return rows[0]?.y ?? 10;
  }

  async insertImport(tx: TenantTx, n: NewImport): Promise<ImportRow> {
    const { rows } = await tx.query(
      `INSERT INTO app.tb_imports (tenant_id, id, engagement_id, tb_kind, as_of_date, currency, source_object_key,
                                   source_sha256, source_filename, source_format, source_size_bytes)
       VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5, $6, decode($7, 'hex'), $8, $9, $10)
       RETURNING id`,
      [n.id, n.engagementId, n.tbKind, n.asOfDate, n.currency, n.sourceObjectKey, n.sourceSha256Hex,
       n.sourceFilename, n.sourceFormat, n.sourceSizeBytes]);
    return (await this.getImport(tx, rows[0]!.id))!;
  }

  async getImport(tx: TenantTx, id: string, forUpdate = false): Promise<ImportRow | null> {
    const { rows } = await tx.query(
      `SELECT ${IMPORT_COLUMNS} FROM app.tb_imports i WHERE i.id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] ? toImport(rows[0]) : null;
  }

  async listImports(tx: TenantTx, engagementId: string): Promise<ImportRow[]> {
    const { rows } = await tx.query(
      `SELECT ${IMPORT_COLUMNS} FROM app.tb_imports i WHERE i.engagement_id = $1 ORDER BY i.created_at DESC LIMIT 100`,
      [engagementId]);
    return rows.map(toImport);
  }

  // ---------------------------------------------------------------------------
  // Worker (ingestion service principal)
  // ---------------------------------------------------------------------------
  async markProcessing(tx: TenantTx, id: string): Promise<boolean> {
    const r = await tx.query(`UPDATE app.tb_imports SET status = 'processing' WHERE id = $1 AND status = 'received'`, [id]);
    return r.rowCount === 1;
  }

  async markFailed(tx: TenantTx, id: string, code: string, message: string): Promise<void> {
    await tx.query(
      `UPDATE app.tb_imports SET status = 'failed', failure_code = $2, failure_message = $3
        WHERE id = $1 AND status IN ('received', 'processing')`,
      [id, code.slice(0, 64), message.slice(0, 500)]);
  }

  /** Creates the TB, writes its lines, and closes it (the DB re-verifies control totals and fixes the digest). */
  async buildTrialBalance(tx: TenantTx, imp: ImportRow, result: ParseResult): Promise<{ id: string; version: number }> {
    const { rows } = await tx.query<{ id: string; version: number }>(
      `INSERT INTO app.trial_balances (tenant_id, engagement_id, tb_kind, version, as_of_date, currency,
                                       source_object_key, source_sha256, source_filename, parser_version,
                                       ctl_line_count, ctl_sum_debit, ctl_sum_credit)
       SELECT app.current_tenant_id(), $1, $2,
              coalesce((SELECT max(t.version) FROM app.trial_balances t WHERE t.engagement_id = $1 AND t.tb_kind = $2), 0) + 1,
              $3, $4, $5, decode($6, 'hex'), $7, $8, $9, $10, $11
       RETURNING id, version`,
      [imp.engagementId, imp.tbKind, imp.asOfDate, imp.currency, imp.sourceObjectKey, imp.sourceSha256Hex,
       imp.sourceFilename, result.parser_version, result.control.line_count, result.control.sum_debit,
       result.control.sum_credit]);
    const tb = rows[0]!;

    for (let i = 0; i < result.lines.length; i += LINE_CHUNK) {
      const chunk = result.lines.slice(i, i + LINE_CHUNK);
      await tx.query(
        `INSERT INTO app.tb_lines (tenant_id, trial_balance_id, engagement_id, line_no, client_account_code,
                                   client_account_name, client_account_name_norm, opening_balance, period_debit,
                                   period_credit, closing_balance, source_had_formula)
         SELECT app.current_tenant_id(), $1, $2, x.line_no, x.code, x.name, x.norm, x.opening, x.pd, x.pc, x.closing, x.f
           FROM unnest($3::int[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::numeric[],
                       $10::numeric[], $11::bool[]) AS x(line_no, code, name, norm, opening, pd, pc, closing, f)`,
        [tb.id, imp.engagementId,
         chunk.map((l) => l.line_no), chunk.map((l) => l.code), chunk.map((l) => l.name), chunk.map((l) => l.name_norm),
         chunk.map((l) => l.opening), chunk.map((l) => l.period_debit), chunk.map((l) => l.period_credit),
         chunk.map((l) => l.closing), chunk.map((l) => l.had_formula)]);
    }
    await tx.query(`UPDATE app.trial_balances SET status = 'imported' WHERE id = $1`, [tb.id]);
    // Earlier, never-locked versions of the same kind are superseded (their decisions carry forward).
    await tx.query(
      `UPDATE app.trial_balances SET status = 'superseded'
        WHERE engagement_id = $1 AND tb_kind = $2 AND id <> $3 AND status IN ('importing', 'imported')`,
      [imp.engagementId, imp.tbKind, tb.id]);
    return tb;
  }

  async markImported(tx: TenantTx, importId: string, tbId: string, parserVersion: string, report: unknown): Promise<void> {
    await tx.query(
      `UPDATE app.tb_imports SET status = 'imported', trial_balance_id = $2, parser_version = $3, report = $4
        WHERE id = $1 AND status = 'processing'`,
      [importId, tbId, parserVersion, JSON.stringify(report)]);
  }

  async setMappingSummary(tx: TenantTx, importId: string, summary: unknown): Promise<void> {
    await tx.query(`UPDATE app.tb_imports SET mapping_summary = $2 WHERE id = $1 AND status = 'imported'`,
      [importId, JSON.stringify(summary)]);
  }

  async llmAllowedForTenant(tx: TenantTx): Promise<boolean> {
    const { rows } = await tx.query<{ ok: boolean }>(
      'SELECT llm_mapping_allowed AS ok FROM platform.tenants WHERE id = app.current_tenant_id()');
    return rows[0]?.ok === true;
  }

  // ---------------------------------------------------------------------------
  // Mapping cascade inputs / outputs
  // ---------------------------------------------------------------------------
  async unmappedLines(tx: TenantTx, tbId: string): Promise<EngineLine[]> {
    const { rows } = await tx.query<{ id: string; line_no: number; code: string; name: string; norm: string; closing: string }>(
      `SELECT l.id, l.line_no, l.client_account_code AS code, l.client_account_name AS name,
              l.client_account_name_norm AS norm, l.closing_balance::text AS closing
         FROM app.tb_lines l
        WHERE l.trial_balance_id = $1
          AND NOT EXISTS (SELECT 1 FROM app.account_mappings m
                           WHERE m.tenant_id = l.tenant_id AND m.tb_line_id = l.id AND m.status IN ('suggested', 'accepted'))
        ORDER BY l.line_no`, [tbId]);
    return rows.map((r) => ({ id: r.id, lineNo: r.line_no, code: r.code, name: r.name, nameNorm: r.norm, closing: r.closing }));
  }

  async postableAccounts(tx: TenantTx): Promise<CoaOption[]> {
    const { rows } = await tx.query<{ id: string; code: string; name_en: string; name_ar: string; account_class: string; normal_balance: 'debit' | 'credit' }>(
      `SELECT id, code, name_en, name_ar, account_class, normal_balance FROM app.coa_accounts WHERE is_postable ORDER BY code`);
    return rows.map((r) => ({ id: r.id, code: r.code, nameEn: r.name_en, nameAr: r.name_ar, accountClass: r.account_class, normalBalance: r.normal_balance }));
  }

  async activeRules(tx: TenantTx): Promise<MappingRule[]> {
    const { rows } = await tx.query<{ kind: MappingRule['kind']; pattern: string; pattern_to: string | null; coa_account_id: string; priority: number }>(
      `SELECT kind, pattern, pattern_to, coa_account_id, priority FROM app.mapping_rules
        WHERE is_active ORDER BY priority, created_at`);
    return rows.map((r) => ({ kind: r.kind, pattern: r.pattern, patternTo: r.pattern_to, coaAccountId: r.coa_account_id, priority: r.priority }));
  }

  /**
   * Accepted decisions of the SAME CLIENT: earlier versions of this
   * engagement's TBs first (newest first), then locked TBs of earlier
   * engagements (newest period first).
   */
  async clientHistory(tx: TenantTx, engagementId: string, excludeTbId: string): Promise<HistoryHit[]> {
    const { rows } = await tx.query<{ code: string; norm: string; coa_account_id: string; same: boolean }>(
      `WITH cur AS (SELECT e.id, e.client_id, e.period_start FROM app.engagements e WHERE e.id = $1),
            src AS (
              SELECT t.id AS tb_id, (t.engagement_id = cur.id) AS same, e.period_end, t.version
                FROM cur
                JOIN app.engagements e ON e.client_id = cur.client_id
                JOIN app.trial_balances t ON t.engagement_id = e.id
               WHERE t.id <> $2
                 AND ((t.engagement_id = cur.id AND t.status IN ('imported', 'superseded', 'locked'))
                      OR (e.period_end < cur.period_start AND t.status = 'locked')))
       SELECT l.client_account_code AS code, l.client_account_name_norm AS norm, m.coa_account_id, src.same
         FROM src
         JOIN app.account_mappings m ON m.trial_balance_id = src.tb_id AND m.status = 'accepted'
         JOIN app.tb_lines l ON l.tenant_id = m.tenant_id AND l.id = m.tb_line_id
        ORDER BY src.same DESC, src.period_end DESC, src.version DESC, m.decided_at DESC`,
      [engagementId, excludeTbId]);
    return rows.map((r) => ({ code: r.code, nameNorm: r.norm, coaAccountId: r.coa_account_id, sameEngagement: r.same }));
  }

  async insertSuggestions(tx: TenantTx, engagementId: string, tbId: string, suggestions: readonly Suggestion[]): Promise<void> {
    for (let i = 0; i < suggestions.length; i += LINE_CHUNK) {
      const chunk = suggestions.slice(i, i + LINE_CHUNK);
      await tx.query(
        `INSERT INTO app.account_mappings (tenant_id, engagement_id, trial_balance_id, tb_line_id, coa_account_id,
                                           source, confidence, model_ref, rationale)
         SELECT app.current_tenant_id(), $1, $2, x.line, x.coa, x.source::app.mapping_source, x.conf, x.model_ref, x.rationale
           FROM unnest($3::uuid[], $4::uuid[], $5::text[], $6::numeric[], $7::text[], $8::text[])
                AS x(line, coa, source, conf, model_ref, rationale)`,
        [engagementId, tbId, chunk.map((s) => s.lineId), chunk.map((s) => s.coaAccountId), chunk.map((s) => s.source),
         chunk.map((s) => s.confidence.toFixed(4)), chunk.map((s) => s.modelRef), chunk.map((s) => s.rationale)]);
    }
  }

  // ---------------------------------------------------------------------------
  // Review (human context)
  // ---------------------------------------------------------------------------
  async trialBalance(tx: TenantTx, tbId: string) {
    const { rows } = await tx.query<Record<string, any>>(
      `SELECT t.id, t.engagement_id, t.tb_kind, t.version, t.as_of_date::text, t.currency, t.status, t.source_filename,
              t.parser_version, t.ctl_line_count, t.ctl_sum_debit::text, t.ctl_sum_credit::text,
              encode(t.lines_sha256, 'hex') AS lines_sha256, t.locked_by, t.locked_at::text,
              (SELECT count(*) FROM app.account_mappings m WHERE m.trial_balance_id = t.id AND m.status = 'accepted') AS accepted,
              (SELECT count(DISTINCT m.tb_line_id) FROM app.account_mappings m
                WHERE m.trial_balance_id = t.id AND m.status = 'suggested'
                  AND NOT EXISTS (SELECT 1 FROM app.account_mappings a WHERE a.tenant_id = m.tenant_id
                                   AND a.tb_line_id = m.tb_line_id AND a.status = 'accepted')) AS pending
         FROM app.trial_balances t WHERE t.id = $1`, [tbId]);
    const r = rows[0];
    if (!r) return null;
    const lines = Number(r.ctl_line_count);
    const accepted = Number(r.accepted);
    const pending = Number(r.pending);
    return {
      id: r.id, engagementId: r.engagement_id, kind: r.tb_kind, version: r.version, asOfDate: r.as_of_date,
      currency: r.currency, status: r.status, sourceFilename: r.source_filename, parserVersion: r.parser_version,
      control: { lineCount: lines, sumDebit: r.ctl_sum_debit, sumCredit: r.ctl_sum_credit },
      linesSha256: r.lines_sha256, lockedBy: r.locked_by, lockedAt: r.locked_at,
      mapping: { accepted, pendingSuggestion: pending, unmapped: lines - accepted - pending },
    };
  }

  async reviewLines(tx: TenantTx, tbId: string, afterLine: number, limit: number) {
    const { rows } = await tx.query<Record<string, any>>(
      `SELECT l.id, l.line_no, l.client_account_code, l.client_account_name, l.closing_balance::text AS closing,
              l.source_had_formula,
              acc.id AS acc_id, acc.code AS acc_code, acc.name_en AS acc_name_en, acc.source AS acc_source,
              acc.decided_by AS acc_decided_by,
              sug.id AS sug_id, sug.code AS sug_code, sug.name_en AS sug_name_en, sug.name_ar AS sug_name_ar,
              sug.source AS sug_source, sug.confidence::float8 AS sug_confidence, sug.model_ref AS sug_model_ref,
              sug.rationale AS sug_rationale, sug.normal_balance AS sug_normal_balance, sug.coa_account_id AS sug_coa
         FROM app.tb_lines l
         LEFT JOIN LATERAL (
           SELECT m.id, c.code, c.name_en, m.source, m.decided_by FROM app.account_mappings m
             JOIN app.coa_accounts c ON c.tenant_id = m.tenant_id AND c.id = m.coa_account_id
            WHERE m.tenant_id = l.tenant_id AND m.tb_line_id = l.id AND m.status = 'accepted') acc ON true
         LEFT JOIN LATERAL (
           SELECT m.id, c.code, c.name_en, c.name_ar, c.normal_balance, m.coa_account_id, m.source, m.confidence,
                  m.model_ref, m.rationale
             FROM app.account_mappings m
             JOIN app.coa_accounts c ON c.tenant_id = m.tenant_id AND c.id = m.coa_account_id
            WHERE m.tenant_id = l.tenant_id AND m.tb_line_id = l.id AND m.status = 'suggested'
            ORDER BY m.confidence DESC NULLS LAST, m.created_at DESC LIMIT 1) sug ON true
        WHERE l.trial_balance_id = $1 AND l.line_no > $2
        ORDER BY l.line_no LIMIT $3`, [tbId, afterLine, limit]);
    return rows;
  }

  /** Per-account counts of live suggestions/acceptances, for the concentration flag. */
  async accountLoad(tx: TenantTx, tbId: string): Promise<{ counts: Map<string, number>; lines: number }> {
    const { rows } = await tx.query<{ coa_account_id: string; n: string }>(
      `SELECT coa_account_id, count(DISTINCT tb_line_id) AS n FROM app.account_mappings
        WHERE trial_balance_id = $1 AND status IN ('suggested', 'accepted') GROUP BY coa_account_id`, [tbId]);
    const total = await tx.query<{ n: string }>('SELECT count(*) AS n FROM app.tb_lines WHERE trial_balance_id = $1', [tbId]);
    return { counts: new Map(rows.map((r) => [r.coa_account_id, Number(r.n)])), lines: Number(total.rows[0]?.n ?? 0) };
  }

  async suggestionForDecision(tx: TenantTx, mappingId: string) {
    const { rows } = await tx.query<Record<string, any>>(
      `SELECT m.id, m.status, m.tb_line_id, m.trial_balance_id, m.coa_account_id, m.confidence::float8 AS confidence,
              l.client_account_name AS name, l.closing_balance::text AS closing, c.normal_balance
         FROM app.account_mappings m
         JOIN app.tb_lines l ON l.tenant_id = m.tenant_id AND l.id = m.tb_line_id
         JOIN app.coa_accounts c ON c.tenant_id = m.tenant_id AND c.id = m.coa_account_id
        WHERE m.id = $1 FOR UPDATE OF m`, [mappingId]);
    return rows[0] ?? null;
  }

  /** Accept one suggestion: the line's previous acceptance and competing suggestions become history. */
  async accept(tx: TenantTx, mappingId: string, lineId: string): Promise<void> {
    await tx.query(`UPDATE app.account_mappings SET status = 'superseded' WHERE tb_line_id = $1 AND status = 'accepted'`, [lineId]);
    await tx.query(`UPDATE app.account_mappings SET status = 'accepted' WHERE id = $1 AND status = 'suggested'`, [mappingId]);
    await tx.query(
      `UPDATE app.account_mappings SET status = 'superseded' WHERE tb_line_id = $1 AND status = 'suggested' AND id <> $2`,
      [lineId, mappingId]);
  }

  async reject(tx: TenantTx, mappingId: string): Promise<boolean> {
    const r = await tx.query(`UPDATE app.account_mappings SET status = 'rejected' WHERE id = $1 AND status = 'suggested'`, [mappingId]);
    return r.rowCount === 1;
  }

  async lineOfTrialBalance(tx: TenantTx, tbId: string, lineId: string): Promise<{ engagementId: string } | null> {
    const { rows } = await tx.query<{ engagement_id: string }>(
      'SELECT engagement_id FROM app.tb_lines WHERE trial_balance_id = $1 AND id = $2', [tbId, lineId]);
    return rows[0] ? { engagementId: rows[0].engagement_id } : null;
  }

  async accountIdByCode(tx: TenantTx, code: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM app.coa_accounts WHERE code = $1', [code]);
    return rows[0]?.id ?? null;
  }

  async manualMapping(tx: TenantTx, engagementId: string, tbId: string, lineId: string, coaId: string, rationale: string): Promise<string> {
    await tx.query(`UPDATE app.account_mappings SET status = 'superseded'
                     WHERE tb_line_id = $1 AND status IN ('accepted', 'suggested')`, [lineId]);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO app.account_mappings (tenant_id, engagement_id, trial_balance_id, tb_line_id, coa_account_id,
                                         source, status, rationale)
       VALUES (app.current_tenant_id(), $1, $2, $3, $4, 'manual', 'accepted', $5) RETURNING id`,
      [engagementId, tbId, lineId, coaId, rationale]);
    return rows[0]!.id;
  }

  async lock(tx: TenantTx, tbId: string): Promise<{ lockedAt: string } | null> {
    const { rows } = await tx.query<{ locked_at: string }>(
      `UPDATE app.trial_balances SET status = 'locked' WHERE id = $1 AND status = 'imported' RETURNING locked_at::text`, [tbId]);
    return rows[0] ? { lockedAt: rows[0].locked_at } : null;
  }

  async chartOfAccounts(tx: TenantTx, postableOnly: boolean) {
    const { rows } = await tx.query<Record<string, any>>(
      `SELECT id, code, path::text AS path, name_en, name_ar, account_class, normal_balance, fs_statement, is_postable
         FROM app.coa_accounts ${postableOnly ? 'WHERE is_postable' : ''} ORDER BY path`);
    return rows.map((r) => ({
      id: r.id, code: r.code, path: r.path, nameEn: r.name_en, nameAr: r.name_ar, accountClass: r.account_class,
      normalBalance: r.normal_balance, fsStatement: r.fs_statement, isPostable: r.is_postable,
    }));
  }

  async listRules(tx: TenantTx) {
    const { rows } = await tx.query<Record<string, any>>(
      `SELECT r.id, r.priority, r.kind, r.pattern, r.pattern_to, c.code AS coa_code, r.description, r.is_active
         FROM app.mapping_rules r JOIN app.coa_accounts c ON c.tenant_id = r.tenant_id AND c.id = r.coa_account_id
        ORDER BY r.priority, r.created_at`);
    return rows.map((r) => ({
      id: r.id, priority: r.priority, kind: r.kind, pattern: r.pattern, patternTo: r.pattern_to, coaCode: r.coa_code,
      description: r.description, isActive: r.is_active,
    }));
  }

  async insertRule(tx: TenantTx, rule: { priority: number; kind: MappingRule['kind']; pattern: string; patternTo: string | null; coaId: string; description: string | null }): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO app.mapping_rules (tenant_id, priority, kind, pattern, pattern_to, coa_account_id, description)
       VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [rule.priority, rule.kind, rule.pattern, rule.patternTo, rule.coaId, rule.description]);
    return rows[0]!.id;
  }

  async deactivateRule(tx: TenantTx, id: string): Promise<boolean> {
    const r = await tx.query('UPDATE app.mapping_rules SET is_active = false WHERE id = $1', [id]);
    return r.rowCount === 1;
  }
}
