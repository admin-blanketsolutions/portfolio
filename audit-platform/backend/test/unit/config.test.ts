import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';

const base = {
  DATABASE_URL: 'postgres://app@db/audit',
  CTX_SIGNING_KEY_ID: 'k1',
  CTX_SIGNING_KEY: 'x'.repeat(40),
  JOB_ENVELOPE_KEY: 'y'.repeat(40),
  OIDC_AUDIENCE: 'audit-platform-api',
  TENANT_BASE_DOMAIN: 'app.example.com',
  DEPLOYMENT_REGION: 'me-central-1',
};

describe('configuration', () => {
  it('keeps development defaults outside production', () => {
    const c = loadConfig({ ...base });
    expect(c.OBJECT_STORE_DRIVER).toBe('memory');
    expect(c.TENANT_KMS_KEY_TEMPLATE).toBe('alias/audit-tenant-{tenantId}');
  });

  it('refuses the in-memory store and an unpinned bucket owner in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/OBJECT_STORE_DRIVER[\s\S]*S3_EXPECTED_BUCKET_OWNER/);
  });

  it('requires the container parser, pinned by digest, in production', () => {
    const prod = { ...base, NODE_ENV: 'production', OBJECT_STORE_DRIVER: 's3', S3_EXPECTED_BUCKET_OWNER: '123456789012' };
    expect(() => loadConfig(prod)).toThrow(/TB_PARSER_DRIVER/);
    expect(() => loadConfig({ ...prod, TB_PARSER_DRIVER: 'container' })).toThrow(/TB_PARSER_IMAGE: is required/);
    expect(() => loadConfig({ ...prod, TB_PARSER_DRIVER: 'container', TB_PARSER_IMAGE: 'registry/audit-tb-parser:latest' }))
      .toThrow(/pinned by digest/);
    const ok = loadConfig({ ...prod, TB_PARSER_DRIVER: 'container', TB_PARSER_IMAGE: `registry/audit-tb-parser@sha256:${'a'.repeat(64)}` });
    expect(ok.TB_PARSER_DRIVER).toBe('container');
  });

  it('refuses a plain-http S3 endpoint in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', OBJECT_STORE_DRIVER: 's3', S3_EXPECTED_BUCKET_OWNER: '123456789012',
      TB_PARSER_DRIVER: 'container', TB_PARSER_IMAGE: `r/p@sha256:${'a'.repeat(64)}`, S3_ENDPOINT: 'http://s3.internal' })).toThrow(/S3_ENDPOINT: must be https/);
  });

  it('requires the tenant placeholder in the KMS key template', () => {
    expect(() => loadConfig({ ...base, TENANT_KMS_KEY_TEMPLATE: 'alias/one-key-for-all' })).toThrow(/TENANT_KMS_KEY_TEMPLATE/);
  });

  it('never echoes secret values in errors', () => {
    try {
      loadConfig({ ...base, CTX_SIGNING_KEY: 'short-secret-value' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('CTX_SIGNING_KEY');
      expect((err as Error).message).not.toContain('short-secret-value');
    }
  });
});
