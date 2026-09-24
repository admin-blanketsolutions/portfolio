import { Global, Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type pg from 'pg';
import { decodeSecret, type AppConfig } from '../config/config.js';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { createPool } from '../database/pool.js';
import { TenantDb } from '../database/tenant-db.js';
import { ContextSigner } from './context-signer.js';
import { TenantContextGuard } from './tenant-context.guard.js';
import { TenantContextInterceptor } from './tenant-context.interceptor.js';
import { PgTenantDirectory } from './tenant-directory.js';
import { JoseOidcVerifier, type TokenVerifier } from './token-verifier.js';
import { APP_CONFIG, CONTEXT_SIGNER, PG_POOL, TENANT_DB, TENANT_DIRECTORY, TOKEN_VERIFIER } from './tokens.js';

export interface TenancyOptions {
  /** Replace OIDC verification (tests use a local JWKS; nothing else should). */
  tokenVerifier?: TokenVerifier;
}

/**
 * Global tenancy wiring. The guard + interceptor are registered as APP_*
 * providers, so every route is tenant-bound unless explicitly @Public().
 * APP_CONFIG is provided by AppModule.forRoot().
 */
@Global()
@Module({})
export class TenancyModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  static forRoot(options: TenancyOptions = {}): DynamicModule {
    return {
      module: TenancyModule,
      providers: [
        { provide: PG_POOL, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createPool(c) },
        {
          provide: CONTEXT_SIGNER,
          inject: [APP_CONFIG],
          useFactory: (c: AppConfig) => new ContextSigner(c.CTX_SIGNING_KEY_ID, decodeSecret(c.CTX_SIGNING_KEY), c.CTX_TTL_SECONDS),
        },
        {
          provide: TENANT_DB,
          inject: [PG_POOL, CONTEXT_SIGNER, APP_CONFIG],
          useFactory: (pool: pg.Pool, signer: ContextSigner, c: AppConfig) => new TenantDb(pool, signer, c.DB_STATEMENT_TIMEOUT_MS),
        },
        { provide: TENANT_DIRECTORY, inject: [PG_POOL], useFactory: (pool: pg.Pool) => new PgTenantDirectory(pool) },
        {
          provide: TOKEN_VERIFIER,
          inject: [APP_CONFIG],
          useFactory: (c: AppConfig) => options.tokenVerifier ?? new JoseOidcVerifier(c.OIDC_AUDIENCE),
        },
        { provide: APP_GUARD, useClass: TenantContextGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_FILTER, useClass: DomainErrorFilter },
      ],
      exports: [PG_POOL, CONTEXT_SIGNER, TENANT_DB, TENANT_DIRECTORY, TOKEN_VERIFIER],
    };
  }
}
