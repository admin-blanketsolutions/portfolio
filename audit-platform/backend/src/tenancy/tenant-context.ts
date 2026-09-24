import { AsyncLocalStorage } from 'node:async_hooks';

export type PrincipalKind = 'staff' | 'client_contact' | 'service';

/**
 * The authenticated, tenant-bound identity for one unit of work (an HTTP
 * request or a background job). Built only from a verified IdP token plus the
 * database's principal lookup — never from headers, paths or bodies.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly userId: string;
  readonly kind: PrincipalKind;
  readonly isFirmAdmin: boolean;
  readonly homeRegion: string;
  readonly requestId: string;
}

export class MissingTenantContextError extends Error {
  constructor() {
    super('No tenant context is active; tenant data access is refused (fail closed).');
    this.name = 'MissingTenantContextError';
  }
}

export class TenantContextSwitchError extends Error {
  constructor() {
    super('Refusing to enter a different tenant context from inside an active one.');
    this.name = 'TenantContextSwitchError';
  }
}

// One store for the whole process. AsyncLocalStorage follows the async call
// graph, so concurrent requests for different tenants cannot observe each
// other's context — unlike a module-level "current tenant" variable or a
// mutable field on a singleton service.
const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Runs `fn` with `ctx` as the active tenant context. Nesting is allowed only
 * for the SAME tenant and user (e.g. a helper re-entering); entering another
 * tenant from inside one is a bug and throws. Cross-tenant platform jobs must
 * first leave the context with `withoutTenantContext`.
 */
export function runWithTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  const outer = storage.getStore();
  if (outer && (outer.tenantId !== ctx.tenantId || outer.userId !== ctx.userId)) {
    throw new TenantContextSwitchError();
  }
  return storage.run(Object.freeze({ ...ctx }), fn);
}

/** Explicitly leave any tenant context (for platform-level iteration over tenants). */
export function withoutTenantContext<T>(fn: () => T): T {
  return storage.exit(fn);
}

export function currentTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

export function requireTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingTenantContextError();
  return ctx;
}

/** Flag string understood by sec.verified_ctx(): '-' | combination of A/S/C. */
export function contextFlags(ctx: Pick<TenantContext, 'kind' | 'isFirmAdmin'>): string {
  let flags = '';
  if (ctx.isFirmAdmin) flags += 'A';
  if (ctx.kind === 'service') flags += 'S';
  if (ctx.kind === 'client_contact') flags += 'C';
  return flags === '' ? '-' : flags;
}

export function kindFromFlags(flags: string): PrincipalKind {
  if (flags.includes('S')) return 'service';
  if (flags.includes('C')) return 'client_contact';
  return 'staff';
}
