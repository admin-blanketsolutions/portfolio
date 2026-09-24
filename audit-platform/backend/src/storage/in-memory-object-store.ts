import { createHash } from 'node:crypto';
import type { ObjectStorePort, PutObjectRequest } from './tenant-object-store.js';

/**
 * Development / test adapter. It enforces the two S3 behaviours the platform
 * relies on, so code that works here does not silently depend on laxer rules:
 * the upload checksum must match, and a key under COMPLIANCE Object Lock can
 * never be overwritten.
 */
export class InMemoryObjectStore implements ObjectStorePort {
  private readonly objects = new Map<string, { body: Uint8Array; req: Omit<PutObjectRequest, 'Body'> }>();

  async putObject(req: PutObjectRequest): Promise<{ versionId?: string }> {
    const id = `${req.Bucket}/${req.Key}`;
    const digest = createHash('sha256').update(req.Body).digest('base64');
    if (digest !== req.ChecksumSHA256) throw new Error('BadDigest: checksum mismatch');
    if (this.objects.has(id)) throw new Error('AccessDenied: object is under Object Lock');
    const { Body, ...meta } = req;
    this.objects.set(id, { body: Uint8Array.from(Body), req: meta });
    return { versionId: '1' };
  }

  async getObject(bucket: string, key: string): Promise<Uint8Array> {
    const obj = this.objects.get(`${bucket}/${key}`);
    if (!obj) throw new Error('NoSuchKey');
    return Uint8Array.from(obj.body);
  }

  async presignGetObject(bucket: string, key: string, expiresInSeconds: number): Promise<string> {
    return `memory://${bucket}/${key}?expires=${expiresInSeconds}`;
  }

  /** Test helper: metadata of a stored object (encryption, lock, tags). */
  describe(bucket: string, key: string): Omit<PutObjectRequest, 'Body'> | undefined {
    return this.objects.get(`${bucket}/${key}`)?.req;
  }
}
