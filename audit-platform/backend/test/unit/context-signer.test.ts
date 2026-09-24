import { describe, expect, it } from 'vitest';
import { ContextSigner } from '../../src/tenancy/context-signer.js';
import { KEY, TENANT_A, TENANT_B, USER_A, ctx } from './fixtures.js';

describe('ContextSigner', () => {
  const now = 1_790_000_000_000;
  const signer = new ContextSigner('test-k1', KEY, 60, () => now);

  it('mints the v1 wire format the database parses', () => {
    const token = signer.mint(ctx(TENANT_A, USER_A));
    expect(token).toMatch(/^v1\.test-k1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.-\.[0-9]+\.[0-9a-f]{64}$/);
    expect(token.split('.')[5]).toBe(String(now / 1000 + 60));
  });

  it('encodes principal flags', () => {
    const flags = (over: Parameters<typeof ctx>[2]) => signer.mint(ctx(TENANT_A, USER_A, over)).split('.')[4];
    expect(flags({})).toBe('-');
    expect(flags({ isFirmAdmin: true })).toBe('A');
    expect(flags({ kind: 'service' })).toBe('S');
    expect(flags({ kind: 'client_contact' })).toBe('C');
  });

  it('round-trips and rejects any tampering', () => {
    const token = signer.mint(ctx(TENANT_A, USER_A));
    expect(signer.verify(token).tenantId).toBe(TENANT_A);
    const parts = token.split('.');
    const swap = (i: number, v: string) => parts.map((p, j) => (j === i ? v : p)).join('.');
    expect(() => signer.verify(swap(2, TENANT_B))).toThrow(/signature/);
    expect(() => signer.verify(swap(4, 'A'))).toThrow(/signature/);
    expect(() => signer.verify(swap(5, '9999999999'))).toThrow(/signature/);
    expect(() => signer.verify(swap(1, 'other-key'))).toThrow(/malformed/);
  });

  it('expires', () => {
    const token = signer.mint(ctx(TENANT_A, USER_A));
    const later = new ContextSigner('test-k1', KEY, 60, () => now + 61_000);
    expect(() => later.verify(token)).toThrow(/expired/);
  });

  it('refuses weak configuration and non-UUID ids (no delimiter injection)', () => {
    expect(() => new ContextSigner('test-k1', Buffer.alloc(16), 60)).toThrow(/32 bytes/);
    expect(() => new ContextSigner('Bad.Id', KEY, 60)).toThrow(/key id/);
    expect(() => new ContextSigner('test-k1', KEY, 3600)).toThrow(/TTL/);
    expect(() => signer.mint(ctx(`${TENANT_A}.x`, USER_A))).toThrow(/UUID/);
  });
});
