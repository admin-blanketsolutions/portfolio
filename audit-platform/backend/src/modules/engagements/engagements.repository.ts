import type { TenantTx } from '../../database/tenant-db.js';

export type EngagementStage = 'planning' | 'fieldwork' | 'review' | 'reporting' | 'completed' | 'archived';

export interface EngagementSummary {
  id: string;
  code: string;
  stage: EngagementStage;
  periodStart: string;
  periodEnd: string;
  reportingCurrency: string;
}

export interface FsRollupRow {
  path: string;
  code: string;
  nameEn: string;
  nameAr: string;
  depth: number;
  unadjusted: string;   // numeric as string: never through a JS float
  aje: string;
  rje: string;
  adjusted: string;
}

export interface StatementNode {
  code: string;
  path: string;
  nameEn: string;
  nameAr: string;
  /** Depth below the statement root (sections are 1). */
  level: number;
  isPostable: boolean;
  accountClass: string;
  /** Adjusted balance in the section's natural sign (e.g. liabilities positive). Decimal string. */
  amount: string;
}

export interface Statements {
  currency: string | null;
  trialBalance: { id: string; version: number; asOfDate: string; lockedAt: string; sourceFilename: string } | null;
  balanceSheet: StatementNode[];
  incomeStatement: StatementNode[];
  totals: { assets: string; liabilitiesAndEquity: string; profit: string; balanced: boolean };
  integrity: Array<{ check: string; ok: boolean }>;
}

/** Negate a decimal string without a float round-trip. */
function negate(v: string): string {
  if (/^-?0*(\.0*)?$/.test(v)) return v.replace(/^-/, '');
  return v.startsWith('-') ? v.slice(1) : `-${v}`;
}

function isZero(v: string): boolean {
  return /^-?0*(\.0*)?$/.test(v);
}

/**
 * Repositories take a TenantTx and never mention tenant_id in WHERE clauses
 * for authorisation: RLS does that. (They may still filter by tenant_id for
 * index selectivity; it is never the security boundary.)
 */
export class EngagementsRepository {
  async list(tx: TenantTx): Promise<EngagementSummary[]> {
    const { rows } = await tx.query<{
      id: string; code: string; stage: EngagementStage; period_start: string; period_end: string; reporting_currency: string;
    }>(
      `SELECT id, code, stage, period_start::text, period_end::text, reporting_currency
         FROM app.engagements
        ORDER BY period_end DESC, code`,
    );
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      stage: r.stage,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      reportingCurrency: r.reporting_currency,
    }));
  }

  async changeStage(tx: TenantTx, engagementId: string, stage: EngagementStage): Promise<EngagementStage | null> {
    const { rows } = await tx.query<{ stage: EngagementStage }>(
      'UPDATE app.engagements SET stage = $2 WHERE id = $1 RETURNING stage',
      [engagementId, stage],
    );
    return rows[0]?.stage ?? null;
  }

  async fsRollup(tx: TenantTx, engagementId: string): Promise<FsRollupRow[]> {
    const { rows } = await tx.query<{
      path: string; code: string; name_en: string; name_ar: string; depth: number;
      unadjusted: string; aje: string; rje: string; adjusted: string;
    }>(
      `SELECT path::text, code, name_en, name_ar, depth,
              unadjusted::text, aje::text, rje::text, adjusted::text
         FROM app.fs_rollup($1)`,
      [engagementId],
    );
    return rows.map((r) => ({
      path: r.path, code: r.code, nameEn: r.name_en, nameAr: r.name_ar, depth: r.depth,
      unadjusted: r.unadjusted, aje: r.aje, rje: r.rje, adjusted: r.adjusted,
    }));
  }

  /**
   * Draft statements from the locked trial balance (plus posted adjustments),
   * via app.fs_rollup. Presentation rules, independent of any firm's codes:
   *  - each statement's root children are its sections (Assets, Liabilities,
   *    Revenue, ...); every amount under a section is shown in that section's
   *    normal-balance sign, so contra accounts appear negative within it;
   *  - siblings are ordered by the lowest account code beneath them;
   *  - accounts with no balance, and groups with none beneath them, are left out.
   * All arithmetic happens in PostgreSQL numerics.
   */
  async statements(tx: TenantTx, engagementId: string): Promise<Statements | null> {
    const eng = await tx.query<{ reporting_currency: string }>('SELECT reporting_currency FROM app.engagements WHERE id = $1', [engagementId]);
    if (!eng.rows[0]) return null;
    const tb = await tx.query<{ id: string; version: number; as_of_date: string; locked_at: string; source_filename: string }>(
      `SELECT id, version, as_of_date::text, locked_at::text, source_filename FROM app.trial_balances
        WHERE engagement_id = $1 AND tb_kind = 'current_unadjusted' AND status = 'locked'
        ORDER BY version DESC LIMIT 1`, [engagementId]);
    const { rows } = await tx.query<{
      path: string; code: string; name_en: string; name_ar: string; depth: number; fs_statement: string;
      is_postable: boolean; section_normal: string | null; adjusted: string; first_code: string | null; account_class: string;
    }>(
      `WITH r AS (SELECT * FROM app.fs_rollup($1)),
            coa AS (SELECT path, normal_balance, is_postable, code, account_class FROM app.coa_accounts),
            ord AS (SELECT n.path, min(p.code) AS first_code
                      FROM coa n JOIN coa p ON p.is_postable AND p.path <@ n.path GROUP BY n.path)
       SELECT r.path::text, r.code, r.name_en, r.name_ar, r.depth, r.fs_statement::text, r.is_postable,
              sec.normal_balance::text AS section_normal, r.adjusted::text, ord.first_code, me.account_class::text
         FROM r
         JOIN coa me ON me.path = r.path
         LEFT JOIN coa sec ON r.depth >= 2 AND sec.path = subpath(r.path, 0, 2)
         LEFT JOIN ord ON ord.path = r.path
        ORDER BY r.path`, [engagementId]);
    const totals = await tx.query<{ assets: string; le: string; profit: string; balanced: boolean }>(
      `WITH r AS (SELECT * FROM app.fs_rollup($1)),
            s AS (SELECT r.depth, r.fs_statement, a.normal_balance, r.adjusted
                    FROM r JOIN app.coa_accounts a ON a.path = r.path),
            t AS (SELECT coalesce(-sum(adjusted) FILTER (WHERE depth = 1 AND fs_statement IN ('IS', 'OCI')), 0) AS profit,
                         coalesce(sum(adjusted) FILTER (WHERE depth = 2 AND fs_statement = 'BS' AND normal_balance = 'debit'), 0) AS assets,
                         coalesce(-sum(adjusted) FILTER (WHERE depth = 2 AND fs_statement = 'BS' AND normal_balance = 'credit'), 0) AS le
                    FROM s)
       SELECT assets::text, (le + profit)::text AS le, profit::text, assets = le + profit AS balanced FROM t`, [engagementId]);
    const integrity = await tx.query<{ check_name: string; ok: boolean }>('SELECT check_name, ok FROM app.fs_integrity($1)', [engagementId]);

    const withBalance = rows.filter((r) => r.is_postable && !isZero(r.adjusted)).map((r) => r.path);
    const keep = (path: string, postable: boolean) => (postable
      ? withBalance.includes(path)
      : withBalance.some((p) => p.startsWith(`${path}.`)));
    const build = (statement: string): StatementNode[] => {
      const nodes = rows.filter((r) => r.fs_statement === statement && r.depth >= 2 && keep(r.path, r.is_postable));
      // Depth-first, siblings by their lowest account code.
      const children = (parent: string) => nodes
        .filter((n) => n.path.slice(0, n.path.lastIndexOf('.')) === parent)
        .sort((a, b) => (a.first_code ?? a.code).localeCompare(b.first_code ?? b.code, 'en', { numeric: true }));
      const out: StatementNode[] = [];
      const walk = (parent: string) => {
        for (const n of children(parent)) {
          out.push({
            code: n.code, path: n.path, nameEn: n.name_en, nameAr: n.name_ar, level: n.depth - 1, isPostable: n.is_postable,
            accountClass: n.account_class,
            amount: n.section_normal === 'credit' ? negate(n.adjusted) : n.adjusted,
          });
          walk(n.path);
        }
      };
      for (const root of rows.filter((r) => r.fs_statement === statement && r.depth === 1)) walk(root.path);
      return out;
    };
    const t = totals.rows[0]!;
    const lockedTb = tb.rows[0];
    return {
      currency: eng.rows[0].reporting_currency,
      trialBalance: lockedTb ? { id: lockedTb.id, version: lockedTb.version, asOfDate: lockedTb.as_of_date,
        lockedAt: lockedTb.locked_at, sourceFilename: lockedTb.source_filename } : null,
      balanceSheet: lockedTb ? build('BS') : [],
      incomeStatement: lockedTb ? build('IS') : [],
      totals: { assets: t.assets, liabilitiesAndEquity: t.le, profit: t.profit, balanced: t.balanced },
      integrity: integrity.rows.map((r) => ({ check: r.check_name, ok: r.ok })),
    };
  }
}
