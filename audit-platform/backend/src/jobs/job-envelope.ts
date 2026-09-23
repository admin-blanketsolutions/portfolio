import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  requireTenantContext,
  runWithTenantContext,
  withoutTenantContext,
  type PrincipalKind,
  type TenantContext,
} from '../tenancy/tenant-context.js';

/**
 * Background work (TB parsing, AI mapping, FS rendering, anchoring) crosses a
 * queue. The tenant context must cross with it — and must not be forgeable by
 * anyone who can write to the queue (a compromised Redis/SQS producer, a
 * poisoned dead-letter replay). Envelopes are HMAC-sealed with a key separate
 * from the DB context key, and expire.
 *
 * Jobs never escalate: a job runs as the principal that enqueued it. Work that
 * needs the service principal (e.g. the sandboxed parser writing tb_lines) is
 * enqueued by a service context in the first place.
 */
export interface JobEnvelope<P> {
  v: 1;
  jobId: string;
  type: string;
  tenantId: string;
  tenantSlug: string;
  userId: string;
  kind: PrincipalKind;
  isFirmAdmin: boolean;
  homeRegion: string;
  requestId: string;
  issuedAt: number;
  expiresAt: number;
  payload: P;
  mac: string;
}

export class JobEnvelopeError extends Error {
  constructor(reason: string) {
    super(`job envelope rejected: ${reason}`);
    this.name = 'JobEnvelopeError';
  }
}

/** Deterministic JSON (sorted keys) so producer and consumer MAC the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export class JobEnvelopeCodec {
  constructor(
    private readonly key: Buffer,
    private readonly nowMs: () => number = Date.now,
  ) {
    if (key.length < 32) throw new Error('job envelope key must be at least 32 bytes');
  }

  /** Seal a job for the CURRENT tenant context (fails closed without one). */
  seal<P>(type: string, payload: P, ttlSeconds = 3_600): JobEnvelope<P> {
    const ctx = requireTenantContext();
    const now = Math.floor(this.nowMs() / 1000);
    const body: Omit<JobEnvelope<P>, 'mac'> = {
      v: 1,
      jobId: randomUUID(),
      type,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      userId: ctx.userId,
      kind: ctx.kind,
      isFirmAdmin: ctx.isFirmAdmin,
      homeRegion: ctx.homeRegion,
      requestId: ctx.requestId,
      issuedAt: now,
      expiresAt: now + ttlSeconds,
      payload,
    };
    return { ...body, mac: this.mac(body) };
  }

  open<P>(envelope: JobEnvelope<P>): TenantContext {
    if (envelope?.v !== 1 || typeof envelope.mac !== 'string') throw new JobEnvelopeError('malformed');
    const { mac, ...body } = envelope;
    const expected = Buffer.from(this.mac(body), 'hex');
    const given = Buffer.from(mac, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new JobEnvelopeError('bad signature');
    if (envelope.expiresAt < Math.floor(this.nowMs() / 1000)) throw new JobEnvelopeError('expired');
    return {
      tenantId: envelope.tenantId,
      tenantSlug: envelope.tenantSlug,
      userId: envelope.userId,
      kind: envelope.kind,
      isFirmAdmin: envelope.isFirmAdmin,
      homeRegion: envelope.homeRegion,
      requestId: envelope.requestId,
    };
  }

  /**
   * Worker entry point: verify, then run the handler inside the job's tenant
   * context. The worker loop itself runs with NO context, so a handler for
   * tenant A can never inherit tenant B's context from a previous job.
   */
  run<P, R>(envelope: JobEnvelope<P>, handler: (payload: P) => Promise<R>): Promise<R> {
    return withoutTenantContext(() => {
      const ctx = this.open(envelope);
      return runWithTenantContext(ctx, () => handler(envelope.payload));
    });
  }

  private mac(body: object): string {
    return createHmac('sha256', this.key).update(canonicalJson(body), 'utf8').digest('hex');
  }
}
