// Explicit DI tokens: every injection is by token, so the wiring does not
// depend on emitDecoratorMetadata (works identically under tsc, esbuild, swc).
export const APP_CONFIG = Symbol('APP_CONFIG');
export const PG_POOL = Symbol('PG_POOL');
export const CONTEXT_SIGNER = Symbol('CONTEXT_SIGNER');
export const TENANT_DIRECTORY = Symbol('TENANT_DIRECTORY');
export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');
export const TENANT_DB = Symbol('TENANT_DB');

/** Request property holding the frozen TenantContext built by the guard. */
export const REQUEST_TENANT_CONTEXT = Symbol('REQUEST_TENANT_CONTEXT');
