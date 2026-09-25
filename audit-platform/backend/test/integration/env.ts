import pg from 'pg';
import type { AppConfig } from '../../src/config/config.js';

/**
 * Integration suites run against the database produced by
 *   KEEP_DB=1 ADMIN_URL=... ../db/scripts/test.sh
 * with:
 *   ADMIN_DATABASE_URL  superuser URL of that database (fixture setup only)
 *   DATABASE_URL        URL for the audit_app_it login (member of audit_app)
 * They are skipped when these are absent.
 */
export const ADMIN_URL = process.env['ADMIN_DATABASE_URL'];
export const APP_URL = process.env['DATABASE_URL'];
export const enabled = Boolean(ADMIN_URL && APP_URL);

// Mirrors db/tests/00_fixtures.sql (test-only key).
export const TEST_KEY_ID = 'test-k1';
export const TEST_KEY = 'test-only-hmac-key-0123456789abcdef-0123456789';

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    DATABASE_URL: APP_URL ?? '',
    DB_POOL_MAX: 4,
    DB_STATEMENT_TIMEOUT_MS: 5_000,
    CTX_SIGNING_KEY_ID: TEST_KEY_ID,
    CTX_SIGNING_KEY: TEST_KEY,
    CTX_TTL_SECONDS: 60,
    JOB_ENVELOPE_KEY: 'job-envelope-test-key-0123456789abcdef',
    OIDC_AUDIENCE: 'audit-platform-api',
    TENANT_BASE_DOMAIN: 'app.test',
    DEPLOYMENT_REGION: 'me-central-1',
    TB_UPLOAD_MAX_BYTES: 5 * 1024 * 1024,
    TB_PARSER_DIR: '../parser',
    TB_PARSER_TIMEOUT_MS: 60_000,
    // CI runs the TB suites a second time through the container sandbox.
    TB_PARSER_DRIVER: process.env['TB_PARSER_DRIVER'] === 'container' ? 'container' : 'subprocess',
    ...(process.env['TB_PARSER_IMAGE'] ? { TB_PARSER_IMAGE: process.env['TB_PARSER_IMAGE'] } : {}),
    TB_PARSER_CONTAINER_CLI: 'docker',
    TB_PARSER_MEMORY_MB: 1536,
    OBJECT_STORE_DRIVER: 'memory',
    S3_FORCE_PATH_STYLE: false,
    TENANT_KMS_KEY_TEMPLATE: 'alias/audit-tenant-{tenantId}',
    TB_SOURCE_BUCKET: 'audit-tb-sources-test',
    MAPPING_LLM_ENABLED: false,
    MAPPING_LLM_MODEL: 'claude-opus-5',
    MAPPING_LLM_EFFORT: 'medium',
    MAPPING_LLM_BATCH_SIZE: 50,
    ...over,
  };
}

export interface Fixture {
  tenants: Record<'alpha' | 'beta', string>;
  users: Record<string, { id: string; tenantId: string; subject: string }>;
  engagements: Record<string, string>;
}

/** Reads ids created by the SQL fixtures and registers per-tenant OIDC issuers. */
export async function loadFixture(): Promise<Fixture> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`UPDATE platform.tenants SET oidc_issuer = 'https://login.' || split_part(slug, '-', 1) || '.test/'`);
    const t = await admin.query<{ slug: string; id: string }>('SELECT slug, id FROM platform.tenants');
    const u = await admin.query<{ email: string; id: string; tenant_id: string; idp_subject: string }>(
      'SELECT email, id, tenant_id, idp_subject FROM app.users');
    const e = await admin.query<{ code: string; id: string }>('SELECT code, id FROM app.engagements');
    const tenants = Object.fromEntries(t.rows.map((r) => [r.slug.split('-')[0], r.id])) as Fixture['tenants'];
    const users = Object.fromEntries(u.rows.map((r) => [r.email.replace('.test', ''), { id: r.id, tenantId: r.tenant_id, subject: r.idp_subject }]));
    const engagements = Object.fromEntries(e.rows.map((r) => [r.code, r.id]));
    return { tenants, users, engagements };
  } finally {
    await admin.end();
  }
}
