import { describe, expect, it } from 'vitest';
import { TenantCache, type KeyValueStore } from '../../src/cache/tenant-cache.js';
import { MissingTenantContextError, runWithTenantContext } from '../../src/tenancy/tenant-context.js';
import { TENANT_A, TENANT_B, USER_A, USER_B, ctx } from './fixtures.js';

class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  async get(k: string) { return this.data.get(k) ?? null; }
  async set(k: string, v: string) { this.data.set(k, v); }
  async del(k: string) { this.data.delete(k); }
}

describe('TenantCache', () => {
  const store = new MemoryStore();
  const cache = new TenantCache(store, 'balances');

  it('fails closed without a context', () => {
    expect(() => cache.key(['eng-1'])).toThrow(MissingTenantContextError);
  });

  it('namespaces by tenant (hash-tagged) and, by default, by user', () => {
    const a1 = runWithTenantContext(ctx(TENANT_A, USER_A), () => cache.key(['eng-1']));
    const a2 = runWithTenantContext(ctx(TENANT_A, USER_B), () => cache.key(['eng-1']));
    const b1 = runWithTenantContext(ctx(TENANT_B, USER_B), () => cache.key(['eng-1']));
    const aT = runWithTenantContext(ctx(TENANT_A, USER_A), () => cache.key(['eng-1'], 'tenant'));
    expect(a1).toMatch(new RegExp(`^t:\\{${TENANT_A}\\}:balances:u:${USER_A}:[0-9a-f]{32}$`));
    expect(new Set([a1, a2, b1, aT]).size).toBe(4);
  });

  it('cannot be tricked into another tenant key via crafted parts', () => {
    const crafted = runWithTenantContext(ctx(TENANT_A, USER_A), () => cache.key([`x}:balances:u:${USER_B}`]));
    expect(crafted.startsWith(`t:{${TENANT_A}}:balances:u:${USER_A}:`)).toBe(true);
  });

  it('does not serve one tenant\'s cached value to another', async () => {
    await runWithTenantContext(ctx(TENANT_A, USER_A), () => cache.set(['eng-1'], { total: 100 }, 'tenant'));
    const seenByB = await runWithTenantContext(ctx(TENANT_B, USER_B), () => cache.get(['eng-1'], 'tenant'));
    expect(seenByB).toBeUndefined();
  });
});
