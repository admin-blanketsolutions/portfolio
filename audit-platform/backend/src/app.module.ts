import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from './config/config.js';
import { EngagementsModule } from './modules/engagements/engagements.module.js';
import { HealthModule } from './modules/health/health.controller.js';
import { TenancyModule, type TenancyOptions } from './tenancy/tenancy.module.js';
import { APP_CONFIG } from './tenancy/tokens.js';

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: Object.freeze({ ...config }) }],
      exports: [APP_CONFIG],
    };
  }
}

/*
 * Module layout (Phase 1 in bold, later phases plug in beside EngagementsModule):
 *
 *   AppModule
 *   ├── ConfigModule            validated env (zod), frozen
 *   ├── **TenancyModule**       pool, ContextSigner, TenantDb, directory, OIDC verifier,
 *   │                           global guard + ALS interceptor + error filter
 *   ├── HealthModule            @Public liveness/readiness
 *   ├── EngagementsModule       example tenant-bound module (list, stage machine, FS roll-up)
 *   ├── (P2) WorkpapersModule   versions, sign-offs (WebAuthn step-up), evidence
 *   ├── (P3) TbIngestionModule  upload -> sandboxed parser job -> mapping suggestions
 *   ├── (P4) LedgerModule       AJEs, FS generation
 *   └── (P5) SamplingModule, PortalModule, TimesheetsModule
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, tenancy: TenancyOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), TenancyModule.forRoot(tenancy), HealthModule, EngagementsModule],
    };
  }
}
