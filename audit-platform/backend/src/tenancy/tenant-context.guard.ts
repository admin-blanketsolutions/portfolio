import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppConfig } from '../config/config.js';
import { DomainError } from '../common/errors.js';
import { IS_PUBLIC } from './decorators.js';
import { tenantSlugFromHost } from './host.js';
import type { TenantContext } from './tenant-context.js';
import type { TenantDirectory } from './tenant-directory.js';
import { TokenRejectedError, type TokenVerifier } from './token-verifier.js';
import { APP_CONFIG, REQUEST_TENANT_CONTEXT, TENANT_DIRECTORY, TOKEN_VERIFIER } from './tokens.js';

interface HttpRequestLike {
  hostname?: string;
  headers: Record<string, string | string[] | undefined>;
  [REQUEST_TENANT_CONTEXT]?: TenantContext;
}

const UNAUTHENTICATED = () => new DomainError('unauthenticated', 'Authentication required.');
// Unknown tenant, inactive tenant and "no such user" all look the same from
// outside: no tenant/user enumeration through distinguishable errors.
const NOT_FOUND = () => new DomainError('not_found', 'Not found.');

/**
 * Builds the TenantContext for a request:
 *
 *   Host ──► slug ──► tenant_directory(slug) ──► registered issuer + region
 *   Bearer ──► verify against THAT issuer ──► (iss, sub)
 *   resolve_principal(slug, iss, sub) ──► user id, kind, admin flag
 *
 * Tenant identity is never read from headers, path, query or body.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'TENANT_BASE_DOMAIN' | 'DEPLOYMENT_REGION'>,
    @Inject(TENANT_DIRECTORY) private readonly directory: TenantDirectory,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const req = context.switchToHttp().getRequest<HttpRequestLike>();

    const slug = tenantSlugFromHost(req.hostname, this.config.TENANT_BASE_DOMAIN);
    if (!slug) throw NOT_FOUND();
    const tenant = await this.directory.lookup(slug);
    if (!tenant || tenant.status !== 'active' || !tenant.oidcIssuer) throw NOT_FOUND();

    // Data residency: this cell only serves tenants homed in its region.
    if (tenant.homeRegion !== this.config.DEPLOYMENT_REGION) {
      throw new DomainError('misdirected', 'This tenant is served from another region.');
    }

    const auth = req.headers['authorization'];
    const match = typeof auth === 'string' ? /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(auth) : null;
    if (!match?.[1]) throw UNAUTHENTICATED();

    let identity;
    try {
      identity = await this.verifier.verify(match[1], tenant.oidcIssuer);
    } catch (e) {
      if (e instanceof TokenRejectedError) throw UNAUTHENTICATED();
      throw e;
    }

    const principal = await this.directory.resolvePrincipal(slug, identity.issuer, identity.subject);
    if (!principal || principal.tenantId !== tenant.tenantId) throw UNAUTHENTICATED();

    const header = req.headers['x-request-id'];
    const requestId = typeof header === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(header) ? header : randomUUID();

    req[REQUEST_TENANT_CONTEXT] = Object.freeze({
      tenantId: principal.tenantId,
      tenantSlug: slug,
      userId: principal.userId,
      kind: principal.kind,
      isFirmAdmin: principal.isFirmAdmin,
      homeRegion: principal.homeRegion,
      requestId,
    });
    return true;
  }
}
