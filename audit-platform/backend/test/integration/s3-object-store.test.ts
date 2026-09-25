import { createHash, randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutBucketEncryptionCommand,
  PutObjectLockConfigurationCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createObjectStorePort, UnsafeBucketError } from '../../src/storage/object-store-factory.js';
import { ObjectAlreadyExistsError, S3ObjectStore } from '../../src/storage/s3-object-store.js';
import { testConfig } from './env.js';
import { TenantObjectStore } from '../../src/storage/tenant-object-store.js';
import { runWithTenantContext } from '../../src/tenancy/tenant-context.js';
import { TENANT_A, USER_A, ctx } from '../unit/fixtures.js';

/**
 * Runs against an S3-compatible endpoint (CI: moto server) when
 * S3_TEST_ENDPOINT is set, e.g. S3_TEST_ENDPOINT=http://127.0.0.1:4566.
 * The emulator does not implement every S3 rule (see the notes on each test);
 * the adapter's requests are asserted either way.
 */
const ENDPOINT = process.env['S3_TEST_ENDPOINT'] ?? '';
const ENG = '33333333-3333-4333-8333-333333333333';
const REGION = 'me-central-1';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');

describe.skipIf(ENDPOINT === '')('S3ObjectStore against an S3 endpoint', () => {
  process.env['AWS_ACCESS_KEY_ID'] ??= 'test';
  process.env['AWS_SECRET_ACCESS_KEY'] ??= 'test';
  const admin = new S3Client({ region: REGION, endpoint: ENDPOINT, forcePathStyle: true });
  const good = `evidence-${randomUUID().slice(0, 8)}`;
  const bare = `bare-${randomUUID().slice(0, 8)}`;
  const s3 = new S3ObjectStore({ region: REGION, endpoint: ENDPOINT, forcePathStyle: true, maxObjectBytes: 1024 * 1024 });
  const store = new TenantObjectStore(s3, good, (t) => `alias/audit-tenant-${t}`);

  beforeAll(async () => {
    const loc = { CreateBucketConfiguration: { LocationConstraint: REGION } } as const;
    await admin.send(new CreateBucketCommand({ Bucket: good, ObjectLockEnabledForBucket: true, ...loc }));
    await admin.send(new PutObjectLockConfigurationCommand({
      Bucket: good,
      ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 1 } } },
    }));
    await admin.send(new PutBucketEncryptionCommand({
      Bucket: good,
      ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' }, BucketKeyEnabled: true }] },
    }));
    await admin.send(new PutPublicAccessBlockCommand({
      Bucket: good,
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
    }));
    await admin.send(new CreateBucketCommand({ Bucket: bare, ...loc }));
  });

  afterAll(() => { s3.destroy(); admin.destroy(); });

  it('accepts a correctly configured bucket and names every missing safeguard on a bare one', async () => {
    expect(await s3.verifyBucket(good)).toEqual([]);
    const problems = await s3.verifyBucket(bare);
    expect(problems.join('\n')).toMatch(/Object Lock/);
    expect(problems.join('\n')).toMatch(/versioning/);
    expect(problems.join('\n')).toMatch(/encryption/);
    expect(problems.join('\n')).toMatch(/public access/);
  });

  it('stops the boot on an unsafe bucket and starts on a safe one', async () => {
    const c = testConfig({ OBJECT_STORE_DRIVER: 's3', S3_ENDPOINT: ENDPOINT, S3_FORCE_PATH_STYLE: true });
    await expect(createObjectStorePort(c, bare)).rejects.toBeInstanceOf(UnsafeBucketError);
    const port = await createObjectStorePort(c, good);
    expect(port).toBeInstanceOf(S3ObjectStore);
    (port as S3ObjectStore).destroy();
  });

  it('stores a TB source under COMPLIANCE retention with the tenant key and tags, and reads it back', async () => {
    const bytes = new Uint8Array(Buffer.from('Code,Name,Debit,Credit\n101,Cash,1,\n'));
    const retainUntil = new Date(Date.now() + 7 * 86_400_000);
    const importId = randomUUID();
    const { key, versionId } = await runWithTenantContext(ctx(TENANT_A, USER_A), () =>
      store.putTbSource({ engagementId: ENG, importId, bytes, sha256Base64: sha(bytes), contentType: 'text/csv', retainUntil }));
    expect(key).toBe(`tenants/${TENANT_A}/engagements/${ENG}/tb/${importId}`);
    expect(versionId).toBeTruthy();

    const head = await admin.send(new HeadObjectCommand({ Bucket: good, Key: key }));
    expect(head.ServerSideEncryption).toBe('aws:kms');
    expect(head.SSEKMSKeyId).toContain(`alias/audit-tenant-${TENANT_A}`);
    expect(head.ObjectLockMode).toBe('COMPLIANCE');
    expect(Math.abs(head.ObjectLockRetainUntilDate!.getTime() - retainUntil.getTime())).toBeLessThan(1000);
    const tags = await admin.send(new GetObjectTaggingCommand({ Bucket: good, Key: key }));
    expect(tags.TagSet).toEqual(expect.arrayContaining([{ Key: 'tenant', Value: TENANT_A }, { Key: 'class', Value: 'tb-source' }]));

    const back = await runWithTenantContext(ctx(TENANT_A, USER_A), () => store.getOwn(key));
    expect(Buffer.from(back).toString()).toBe(Buffer.from(bytes).toString());

    // The locked version cannot be deleted, not even with valid credentials.
    await expect(admin.send(new DeleteObjectCommand({ Bucket: good, Key: key, VersionId: versionId! }))).rejects.toThrow();
  });

  it('never replaces an existing object', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const req = {
      Bucket: good, Key: `tenants/${TENANT_A}/x/${randomUUID()}`, Body: bytes, ContentType: 'application/octet-stream',
      ChecksumSHA256: sha(bytes), ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: 'alias/k', BucketKeyEnabled: true as const,
      ObjectLockMode: 'COMPLIANCE' as const, ObjectLockRetainUntilDate: new Date(Date.now() + 86_400_000), Tagging: 'tenant=a',
    };
    await s3.putObject(req);
    await expect(s3.putObject({ ...req, Body: new Uint8Array([9]), ChecksumSHA256: sha(new Uint8Array([9])) }))
      .rejects.toBeInstanceOf(ObjectAlreadyExistsError);
  });

  it('refuses a body that does not match the declared checksum', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(s3.putObject({
      Bucket: good, Key: `tenants/${TENANT_A}/x/${randomUUID()}`, Body: bytes, ContentType: 'application/octet-stream',
      ChecksumSHA256: sha(new Uint8Array([4, 5, 6])), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'alias/k', BucketKeyEnabled: true,
      ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date(Date.now() + 86_400_000), Tagging: 'tenant=a',
    })).rejects.toMatchObject({ code: 'BadDigest' });
  });

  it('refuses to read an object larger than the limit', async () => {
    const small = new S3ObjectStore({ region: REGION, endpoint: ENDPOINT, forcePathStyle: true, maxObjectBytes: 2 });
    const bytes = new Uint8Array([1, 2, 3]);
    const key = `tenants/${TENANT_A}/x/${randomUUID()}`;
    await s3.putObject({
      Bucket: good, Key: key, Body: bytes, ContentType: 'application/octet-stream', ChecksumSHA256: sha(bytes),
      ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'alias/k', BucketKeyEnabled: true,
      ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date(Date.now() + 86_400_000), Tagging: 'tenant=a',
    });
    await expect(small.getObject(good, key)).rejects.toMatchObject({ code: 'ObjectTooLarge' });
    small.destroy();
  });

  it('presigns a short-lived download that works and forces an attachment', async () => {
    const bytes = new Uint8Array(Buffer.from('hello'));
    const { key } = await runWithTenantContext(ctx(TENANT_A, USER_A), () =>
      store.putEvidence({ engagementId: ENG, bytes, sha256Base64: sha(bytes), detectedMime: 'text/plain', retainUntil: new Date(Date.now() + 86_400_000) }));
    const url = await runWithTenantContext(ctx(TENANT_A, USER_A), () => store.presignDownload(key, 3600));
    const u = new URL(url);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(u.searchParams.get('response-content-disposition')).toBe('attachment');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });
});
