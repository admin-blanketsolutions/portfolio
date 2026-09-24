import { describe, expect, it } from 'vitest';
import { JobEnvelopeCodec, canonicalJson, type JobEnvelope } from '../../src/jobs/job-envelope.js';
import { MissingTenantContextError, currentTenantContext, requireTenantContext, runWithTenantContext } from '../../src/tenancy/tenant-context.js';
import { KEY, TENANT_A, TENANT_B, USER_A, USER_B, ctx } from './fixtures.js';

describe('JobEnvelopeCodec', () => {
  const codec = new JobEnvelopeCodec(KEY);
  const seal = () => runWithTenantContext(ctx(TENANT_A, USER_A), () => codec.seal('tb.parse', { tbId: 'x', rows: [1, 2] }));

  it('requires an active context to seal', () => {
    expect(() => codec.seal('tb.parse', {})).toThrow(MissingTenantContextError);
  });

  it('runs the handler in the sealed tenant context and nothing leaks out', async () => {
    const env = seal();
    const seen = await codec.run(env, async (p) => ({ tenant: requireTenantContext().tenantId, p }));
    expect(seen.tenant).toBe(TENANT_A);
    expect(currentTenantContext()).toBeUndefined();
  });

  it('runs jobs for different tenants back-to-back without inheriting context', async () => {
    const envB = runWithTenantContext(ctx(TENANT_B, USER_B), () => codec.seal('x', {}));
    // Even when the worker loop itself is (wrongly) inside tenant A's context:
    const seen = await runWithTenantContext(ctx(TENANT_A, USER_A), () =>
      codec.run(envB, async () => requireTenantContext().tenantId));
    expect(seen).toBe(TENANT_B);
  });

  it.each<[string, (e: JobEnvelope<{ tbId: string; rows: number[] }>) => unknown]>([
    ['tenant swap', (e) => ({ ...e, tenantId: TENANT_B })],
    ['privilege escalation', (e) => ({ ...e, kind: 'service' })],
    ['admin flag', (e) => ({ ...e, isFirmAdmin: true })],
    ['payload edit', (e) => ({ ...e, payload: { ...e.payload, tbId: 'y' } })],
    ['expiry extension', (e) => ({ ...e, expiresAt: e.expiresAt + 10_000 })],
  ])('rejects %s', (_name, mutate) => {
    const forged = mutate(seal()) as JobEnvelope<unknown>;
    expect(() => codec.open(forged)).toThrow(/bad signature/);
  });

  it('rejects expired envelopes and envelopes sealed with another key', () => {
    const env = seal();
    const future = new JobEnvelopeCodec(KEY, () => Date.now() + 2 * 3_600_000);
    expect(() => future.open(env)).toThrow(/expired/);
    const other = new JobEnvelopeCodec(Buffer.alloc(32, 7));
    expect(() => other.open(env)).toThrow(/bad signature/);
  });

  it('canonicalises key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });
});
