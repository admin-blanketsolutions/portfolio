import { randomUUID } from 'node:crypto';
import { requireTenantContext } from '../tenancy/tenant-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Shape of an S3 PutObject request (kept SDK-agnostic; map 1:1 onto @aws-sdk/client-s3). */
export interface PutObjectRequest {
  Bucket: string;
  Key: string;
  Body: Uint8Array;
  ContentType: string;
  ChecksumSHA256: string;                    // base64; S3 rejects the upload if bytes differ
  ServerSideEncryption: 'aws:kms';
  SSEKMSKeyId: string;                       // per-tenant CMK (or XKS-backed key for sovereign tenants)
  BucketKeyEnabled: true;
  ObjectLockMode: 'COMPLIANCE';              // not even the root account can shorten it
  ObjectLockRetainUntilDate: Date;
  Tagging: string;
}

export interface ObjectStorePort {
  putObject(req: PutObjectRequest): Promise<{ versionId?: string }>;
  presignGetObject(bucket: string, key: string, expiresInSeconds: number): Promise<string>;
}

export class ForeignObjectKeyError extends Error {
  constructor() {
    super('object key does not belong to the active tenant');
    this.name = 'ForeignObjectKeyError';
  }
}

/**
 * Tenant-bound evidence storage.
 *  - Keys are generated here from the active context; user-supplied file names
 *    never become part of a key (no traversal, no Unicode look-alikes).
 *  - The DB re-checks the prefix (CHECK constraint on app.evidence_files).
 *  - Each tenant's objects are encrypted under that tenant's own KMS key; an
 *    IAM/KMS key policy with `kms:EncryptionContext` / session tags keeps one
 *    tenant's key unusable for another's objects.
 *  - Download URLs are short-lived and only minted for the caller's prefix.
 */
export class TenantObjectStore {
  constructor(
    private readonly port: ObjectStorePort,
    private readonly bucket: string,
    private readonly kmsKeyFor: (tenantId: string) => string,
  ) {}

  evidenceKey(engagementId: string): string {
    const { tenantId } = requireTenantContext();
    if (!UUID.test(engagementId)) throw new Error('engagementId must be a UUID');
    return `tenants/${tenantId}/engagements/${engagementId}/evidence/${randomUUID()}`;
  }

  async putEvidence(input: {
    engagementId: string;
    bytes: Uint8Array;
    sha256Base64: string;
    detectedMime: string;
    retainUntil: Date;
  }): Promise<{ key: string; versionId?: string }> {
    const { tenantId } = requireTenantContext();
    const key = this.evidenceKey(input.engagementId);
    const { versionId } = await this.port.putObject({
      Bucket: this.bucket,
      Key: key,
      Body: input.bytes,
      ContentType: input.detectedMime,
      ChecksumSHA256: input.sha256Base64,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: this.kmsKeyFor(tenantId),
      BucketKeyEnabled: true,
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: input.retainUntil,
      Tagging: `tenant=${tenantId}&class=audit-evidence`,
    });
    return versionId === undefined ? { key } : { key, versionId };
  }

  async presignDownload(key: string, expiresInSeconds = 120): Promise<string> {
    const { tenantId } = requireTenantContext();
    if (!key.startsWith(`tenants/${tenantId}/`) || key.includes('..')) throw new ForeignObjectKeyError();
    return this.port.presignGetObject(this.bucket, key, Math.min(expiresInSeconds, 300));
  }
}
