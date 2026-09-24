import type pg from 'pg';
import { kindFromFlags, type PrincipalKind } from './tenant-context.js';

export interface TenantDirectoryEntry {
  tenantId: string;
  oidcIssuer: string | null;
  homeRegion: string;
  status: 'provisioning' | 'active' | 'suspended' | 'offboarding' | 'closed';
}

export interface ResolvedPrincipal {
  tenantId: string;
  userId: string;
  kind: PrincipalKind;
  isFirmAdmin: boolean;
  homeRegion: string;
}

export interface TenantDirectory {
  lookup(slug: string): Promise<TenantDirectoryEntry | null>;
  resolvePrincipal(slug: string, issuer: string, subject: string): Promise<ResolvedPrincipal | null>;
}

/**
 * Pre-context lookups. These are the ONLY queries issued without a tenant
 * context, and they go through two narrow SECURITY DEFINER functions
 * (db/migrations/V0009) — never through direct table access.
 */
export class PgTenantDirectory implements TenantDirectory {
  constructor(private readonly pool: pg.Pool) {}

  async lookup(slug: string): Promise<TenantDirectoryEntry | null> {
    const { rows } = await this.pool.query<{ tenant_id: string; oidc_issuer: string | null; home_region: string; status: TenantDirectoryEntry['status'] }>(
      'SELECT tenant_id, oidc_issuer, home_region, status FROM platform.tenant_directory($1)',
      [slug],
    );
    const r = rows[0];
    return r ? { tenantId: r.tenant_id, oidcIssuer: r.oidc_issuer, homeRegion: r.home_region, status: r.status } : null;
  }

  async resolvePrincipal(slug: string, issuer: string, subject: string): Promise<ResolvedPrincipal | null> {
    const { rows } = await this.pool.query<{ tenant_id: string; user_id: string; flags: string; home_region: string }>(
      'SELECT tenant_id, user_id, flags, home_region FROM platform.resolve_principal($1, $2, $3)',
      [slug, issuer, subject],
    );
    const r = rows[0];
    if (!r || rows.length !== 1) return null;
    return {
      tenantId: r.tenant_id,
      userId: r.user_id,
      kind: kindFromFlags(r.flags),
      isFirmAdmin: r.flags.includes('A'),
      homeRegion: r.home_region,
    };
  }
}
