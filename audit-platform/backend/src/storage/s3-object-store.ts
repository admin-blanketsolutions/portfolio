import {
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  GetPublicAccessBlockCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ObjectStorePort, PutObjectRequest } from './tenant-object-store.js';

export interface S3ObjectStoreOptions {
  region: string;
  /** Only for S3-compatible test servers; production talks to the regional AWS endpoint. */
  endpoint?: string;
  forcePathStyle?: boolean;
  /**
   * AWS account that must own the bucket. S3 refuses the request otherwise, so
   * a misconfigured or re-created bucket name can never receive client files.
   */
  expectedBucketOwner?: string;
  /** Reads larger than this are refused before the body is downloaded. */
  maxObjectBytes: number;
  /** Test hook: a preconfigured client. */
  client?: S3Client;
}

export class ObjectAlreadyExistsError extends Error {
  constructor() {
    super('an object already exists at this key');
    this.name = 'ObjectAlreadyExistsError';
  }
}

export class ObjectStoreError extends Error {
  constructor(readonly code: string) {
    // Only the S3 error code: messages can echo bucket names and keys.
    super(`object store request failed (${code})`);
    this.name = 'ObjectStoreError';
  }
}

/**
 * AWS S3 adapter for evidence and TB source files.
 *
 *  - Every write carries the SHA-256 we computed from the upload; S3 rejects
 *    the request if the stored bytes differ.
 *  - `If-None-Match: *` makes the write create-only. Object Lock protects
 *    locked versions, but on a versioned bucket a second PUT to the same key
 *    would still become the *current* version; the condition prevents that.
 *  - Reads ask S3 for the stored checksum and the SDK verifies the body
 *    against it before we see the bytes.
 *  - Credentials come from the default provider chain (task / instance role),
 *    never from application configuration.
 */
export class S3ObjectStore implements ObjectStorePort {
  private readonly client: S3Client;

  constructor(private readonly opts: S3ObjectStoreOptions) {
    const config: S3ClientConfig = {
      region: opts.region,
      // We always supply a SHA-256 ourselves on writes; validate on reads.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_SUPPORTED',
      maxAttempts: 3,
    };
    if (opts.endpoint) config.endpoint = opts.endpoint;
    if (opts.forcePathStyle) config.forcePathStyle = true;
    this.client = opts.client ?? new S3Client(config);
  }

  private owner(): { ExpectedBucketOwner?: string } {
    return this.opts.expectedBucketOwner ? { ExpectedBucketOwner: this.opts.expectedBucketOwner } : {};
  }

  async putObject(req: PutObjectRequest): Promise<{ versionId?: string }> {
    // S3 verifies this too; checking first means a caller bug never reaches
    // the bucket, whatever the endpoint enforces.
    const actual = createHash('sha256').update(req.Body).digest();
    const declared = Buffer.from(req.ChecksumSHA256, 'base64');
    if (declared.length !== actual.length || !timingSafeEqual(declared, actual)) throw new ObjectStoreError('BadDigest');
    try {
      const out = await this.client.send(new PutObjectCommand({
        Bucket: req.Bucket,
        Key: req.Key,
        Body: req.Body,
        ContentLength: req.Body.byteLength,
        ContentType: req.ContentType,
        // S3 requires the algorithm header (or Content-MD5) on writes with an
        // Object Lock retention; with the value supplied, the SDK sends ours.
        ChecksumAlgorithm: 'SHA256',
        ChecksumSHA256: req.ChecksumSHA256,
        ServerSideEncryption: req.ServerSideEncryption,
        SSEKMSKeyId: req.SSEKMSKeyId,
        BucketKeyEnabled: req.BucketKeyEnabled,
        ObjectLockMode: req.ObjectLockMode,
        ObjectLockRetainUntilDate: req.ObjectLockRetainUntilDate,
        Tagging: req.Tagging,
        IfNoneMatch: '*',
        ...this.owner(),
      }));
      return out.VersionId === undefined ? {} : { versionId: out.VersionId };
    } catch (err) {
      throw mapError(err);
    }
  }

  async getObject(bucket: string, key: string): Promise<Uint8Array> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED', ...this.owner() }));
      if (!out.Body) throw new ObjectStoreError('EmptyBody');
      if (out.ContentLength !== undefined && out.ContentLength > this.opts.maxObjectBytes) {
        (out.Body as { destroy?: () => void }).destroy?.();
        throw new ObjectStoreError('ObjectTooLarge');
      }
      const bytes = await out.Body.transformToByteArray();
      if (bytes.byteLength > this.opts.maxObjectBytes) throw new ObjectStoreError('ObjectTooLarge');
      return bytes;
    } catch (err) {
      throw mapError(err);
    }
  }

  async presignGetObject(bucket: string, key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...this.owner(),
      // Served as a download, never rendered inline from our domain's links.
      ResponseContentDisposition: 'attachment',
    }), { expiresIn: expiresInSeconds });
  }

  /**
   * Checks the bucket settings the platform's guarantees depend on. The API
   * refuses to start with a bucket that fails any of them, rather than
   * discovering at upload time (or never) that evidence is not immutable.
   */
  async verifyBucket(bucket: string): Promise<string[]> {
    const problems: string[] = [];
    const owner = this.owner();
    // `missing` is the problem when S3 answers that the setting does not exist at all.
    const check = async (missing: string, fn: () => Promise<string | null>) => {
      try {
        const problem = await fn();
        if (problem) problems.push(problem);
      } catch (err) {
        const name = err instanceof S3ServiceException ? err.name : 'request failed';
        problems.push(/NotFound|NoSuch/.test(name) && name !== 'NoSuchBucket' ? missing : `${missing} (could not be checked: ${name})`);
      }
    };
    await check('Object Lock is not enabled', async () => {
      const r = await this.client.send(new GetObjectLockConfigurationCommand({ Bucket: bucket, ...owner }));
      return r.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled' ? null : 'Object Lock is not enabled';
    });
    await check('versioning is not enabled', async () => {
      const r = await this.client.send(new GetBucketVersioningCommand({ Bucket: bucket, ...owner }));
      return r.Status === 'Enabled' ? null : 'versioning is not enabled';
    });
    await check('default encryption is not SSE-KMS', async () => {
      const r = await this.client.send(new GetBucketEncryptionCommand({ Bucket: bucket, ...owner }));
      const algos = (r.ServerSideEncryptionConfiguration?.Rules ?? []).map((x) => x.ApplyServerSideEncryptionByDefault?.SSEAlgorithm);
      return algos.some((a) => a === 'aws:kms' || a === 'aws:kms:dsse') ? null : 'default encryption is not SSE-KMS';
    });
    await check('public access is not fully blocked', async () => {
      const r = await this.client.send(new GetPublicAccessBlockCommand({ Bucket: bucket, ...owner }));
      const c = r.PublicAccessBlockConfiguration;
      return c?.BlockPublicAcls && c.IgnorePublicAcls && c.BlockPublicPolicy && c.RestrictPublicBuckets
        ? null : 'public access is not fully blocked';
    });
    return problems;
  }

  destroy(): void {
    this.client.destroy();
  }
}

function mapError(err: unknown): Error {
  if (err instanceof ObjectStoreError) return err;
  if (err instanceof S3ServiceException) {
    if (err.name === 'PreconditionFailed' || err.$metadata.httpStatusCode === 412) return new ObjectAlreadyExistsError();
    return new ObjectStoreError(err.name);
  }
  // SDK-side failures (e.g. checksum mismatch on read) carry no S3 code.
  return new ObjectStoreError(err instanceof Error ? err.name : 'Unknown');
}
