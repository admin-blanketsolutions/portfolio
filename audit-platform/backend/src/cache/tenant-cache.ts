import { createHash } from 'node:crypto';
import { requireTenantContext } from '../tenancy/tenant-context.js';

/** Minimal port over Redis/ElastiCache (ioredis, node-redis, or a test double). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/**
 * 'user'   — result depends on who is asking (anything behind an ethical wall
 *            or RLS: engagement content, balances, search). DEFAULT.
 * 'tenant' — identical for every user of the tenant (e.g. the firm's COA).
 */
export type CacheScope = 'user' | 'tenant';

/**
 * Caches are the most common place tenant isolation silently disappears: the
 * database enforces RLS, then a cache keyed only by `engagementId` serves the
 * result to the next caller. Keys here are ALWAYS derived from the active
 * tenant context:
 *
 *   t:{<tenantId>}:<namespace>:[u:<userId>:]<sha256(parts)>
 *
 * The `{tenantId}` hash tag co-locates a tenant's keys on one Redis Cluster
 * slot so offboarding/crypto-shredding can delete them deterministically.
 * Caller-supplied parts are hashed, so they cannot inject key separators.
 */
export class TenantCache {
  constructor(
    private readonly store: KeyValueStore,
    private readonly namespace: string,
    private readonly defaultTtlSeconds = 300,
  ) {
    if (!/^[a-z0-9-]{1,32}$/.test(namespace)) throw new Error('invalid cache namespace');
  }

  key(parts: readonly string[], scope: CacheScope = 'user'): string {
    const ctx = requireTenantContext();
    const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
    const user = scope === 'user' ? `u:${ctx.userId}:` : '';
    return `t:{${ctx.tenantId}}:${this.namespace}:${user}${digest}`;
  }

  async get<T>(parts: readonly string[], scope: CacheScope = 'user'): Promise<T | undefined> {
    const raw = await this.store.get(this.key(parts, scope));
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async set<T>(parts: readonly string[], value: T, scope: CacheScope = 'user', ttlSeconds = this.defaultTtlSeconds): Promise<void> {
    await this.store.set(this.key(parts, scope), JSON.stringify(value), ttlSeconds);
  }

  async getOrLoad<T>(parts: readonly string[], load: () => Promise<T>, scope: CacheScope = 'user'): Promise<T> {
    const hit = await this.get<T>(parts, scope);
    if (hit !== undefined) return hit;
    const value = await load();
    await this.set(parts, value, scope);
    return value;
  }
}
