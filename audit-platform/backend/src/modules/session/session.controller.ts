import { Controller, Get, Inject, Module, Req } from '@nestjs/common';
import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import { DomainError } from '../../common/errors.js';
import type { TenantDb } from '../../database/tenant-db.js';
import { Ctx, Public } from '../../tenancy/decorators.js';
import { tenantSlugFromHost } from '../../tenancy/host.js';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import { APP_CONFIG, PG_POOL, TENANT_DB } from '../../tenancy/tokens.js';

/**
 * What the web client needs before and right after sign-in. The login
 * configuration is public (it appears in every OIDC redirect anyway); it is
 * looked up from the Host exactly like the tenant guard does, never from a
 * parameter the caller chooses.
 */
@Controller()
export class SessionController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(TENANT_DB) private readonly db: TenantDb,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('auth/config')
  async authConfig(@Req() req: { hostname?: string }) {
    const slug = tenantSlugFromHost(req.hostname, this.config.TENANT_BASE_DOMAIN);
    if (!slug) throw new DomainError('not_found', 'Not found.');
    const { rows } = await this.pool.query<{ oidc_issuer: string; oidc_web_client_id: string; home_region: string }>(
      'SELECT oidc_issuer, oidc_web_client_id, home_region FROM platform.tenant_login_config($1)', [slug]);
    const r = rows[0];
    if (!r) throw new DomainError('not_found', 'Not found.');
    if (r.home_region !== this.config.DEPLOYMENT_REGION) {
      throw new DomainError('misdirected', 'This tenant is served from another region.');
    }
    return { tenant: slug, issuer: r.oidc_issuer, clientId: r.oidc_web_client_id, audience: this.config.OIDC_AUDIENCE, scope: 'openid profile' };
  }

  @Get('me')
  async me(@Ctx() ctx: TenantContext) {
    const user = await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ display_name: string; display_name_ar: string | null; professional_rank: string | null }>(
        'SELECT display_name, display_name_ar, professional_rank FROM app.users WHERE id = app.current_user_id()');
      return rows[0];
    }, { readOnly: true });
    return {
      tenant: ctx.tenantSlug, userId: ctx.userId, kind: ctx.kind, isFirmAdmin: ctx.isFirmAdmin,
      displayName: user?.display_name ?? null, displayNameAr: user?.display_name_ar ?? null,
      rank: user?.professional_rank ?? null,
    };
  }
}

@Module({ controllers: [SessionController] })
export class SessionModule {}
