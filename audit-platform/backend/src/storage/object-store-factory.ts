import type { AppConfig } from '../config/config.js';
import { InMemoryObjectStore } from './in-memory-object-store.js';
import { S3ObjectStore } from './s3-object-store.js';
import type { ObjectStorePort } from './tenant-object-store.js';

export class UnsafeBucketError extends Error {
  constructor(readonly problems: string[]) {
    super(`bucket is not safe to use:\n  ${problems.join('\n  ')}`);
    this.name = 'UnsafeBucketError';
  }
}

/**
 * Builds the configured object store. For S3 the bucket's safeguards are
 * verified first, and a bucket missing any of them stops the boot.
 */
export async function createObjectStorePort(c: AppConfig, bucket: string): Promise<ObjectStorePort> {
  if (c.OBJECT_STORE_DRIVER === 'memory') return new InMemoryObjectStore();
  const s3 = new S3ObjectStore({
    region: c.S3_REGION ?? c.DEPLOYMENT_REGION,
    ...(c.S3_ENDPOINT ? { endpoint: c.S3_ENDPOINT } : {}),
    forcePathStyle: c.S3_FORCE_PATH_STYLE,
    ...(c.S3_EXPECTED_BUCKET_OWNER ? { expectedBucketOwner: c.S3_EXPECTED_BUCKET_OWNER } : {}),
    maxObjectBytes: c.TB_UPLOAD_MAX_BYTES,
  });
  const problems = await s3.verifyBucket(bucket);
  if (problems.length) {
    s3.destroy();
    throw new UnsafeBucketError(problems);
  }
  return s3;
}
