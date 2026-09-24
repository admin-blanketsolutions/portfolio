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
}
