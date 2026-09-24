import { describe, expect, it } from 'vitest';
import { ForeignObjectKeyError, TenantObjectStore, type ObjectStorePort, type PutObjectRequest } from '../../src/storage/tenant-object-store.js';
import { runWithTenantContext } from '../../src/tenancy/tenant-context.js';
import { TENANT_A, TENANT_B, USER_A, ctx } from './fixtures.js';

const ENG = '33333333-3333-4333-8333-333333333333';

class FakeS3 implements ObjectStorePort {
  puts: PutObjectRequest[] = [];
  async putObject(req: PutObjectRequest) { this.puts.push(req); return { versionId: 'v1' }; }
  async presignGetObject(_b: string, key: string, ttl: number) { return `https://s3/${key}?ttl=${ttl}`; }
}

describe('TenantObjectStore', () => {
  const s3 = new FakeS3();
  const store = new TenantObjectStore(s3, 'evidence-bucket', (t) => `arn:aws:kms:me-central-1:1:key/${t}`);

  it('derives keys and encryption from the active tenant, with Object Lock', async () => {
    const { key } = await runWithTenantContext(ctx(TENANT_A, USER_A), () =>
      store.putEvidence({ engagementId: ENG, bytes: new Uint8Array([1]), sha256Base64: 'x', detectedMime: 'application/pdf', retainUntil: new Date('2036-01-01') }));
    expect(key).toMatch(new RegExp(`^tenants/${TENANT_A}/engagements/${ENG}/evidence/[0-9a-f-]{36}$`));
    const put = s3.puts[0]!;
    expect(put.SSEKMSKeyId).toContain(TENANT_A);
    expect(put.ObjectLockMode).toBe('COMPLIANCE');
    expect(put.ServerSideEncryption).toBe('aws:kms');
  });

  it('refuses to presign another tenant\'s object and caps TTL', async () => {
    await runWithTenantContext(ctx(TENANT_A, USER_A), async () => {
      await expect(store.presignDownload(`tenants/${TENANT_B}/engagements/${ENG}/evidence/x`)).rejects.toBeInstanceOf(ForeignObjectKeyError);
      await expect(store.presignDownload(`tenants/${TENANT_A}/../${TENANT_B}/x`)).rejects.toBeInstanceOf(ForeignObjectKeyError);
      expect(await store.presignDownload(`tenants/${TENANT_A}/engagements/${ENG}/evidence/x`, 3600)).toMatch(/ttl=300$/);
    });
  });
});
