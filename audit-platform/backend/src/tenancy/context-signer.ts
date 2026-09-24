import { createHmac, timingSafeEqual } from 'node:crypto';
import { contextFlags, type TenantContext } from './tenant-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID = /^[a-z0-9-]{1,32}$/;

export interface VerifiedToken {
  tenantId: string;
  userId: string;
  flags: string;
  expiresAt: number;
}

/**
 * Mints the database context token verified by `sec.verified_ctx()`
 * (db/migrations/V0002). Format:
 *
 *   v1.<key_id>.<tenant_uuid>.<user_uuid>.<flags>.<exp_unix>.<hmac_sha256_hex>
 *
 * The key lives only in this process (from the secrets manager) and in
 * `sec.context_signing_keys`, which the app's DB role cannot read. SQL
 * injection in the app therefore cannot forge a context for another tenant.
 */
export class ContextSigner {
  constructor(
    private readonly keyId: string,
    private readonly key: Buffer,
    private readonly ttlSeconds: number,
    private readonly nowMs: () => number = Date.now,
  ) {
    if (!KEY_ID.test(keyId)) throw new Error('invalid context key id');
    if (key.length < 32) throw new Error('context signing key must be at least 32 bytes');
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 5 || ttlSeconds > 120) {
      throw new Error('context TTL must be 5..120 seconds');
    }
  }

  mint(ctx: Pick<TenantContext, 'tenantId' | 'userId' | 'kind' | 'isFirmAdmin'>): string {
    const tenantId = ctx.tenantId.toLowerCase();
    const userId = ctx.userId.toLowerCase();
    if (!UUID.test(tenantId) || !UUID.test(userId)) throw new Error('tenant/user id must be a UUID');
    const exp = Math.floor(this.nowMs() / 1000) + this.ttlSeconds;
    const payload = `v1.${this.keyId}.${tenantId}.${userId}.${contextFlags(ctx)}.${exp}`;
    return `${payload}.${this.mac(payload)}`;
  }

  /** Same checks as the database; used by workers and in tests. */
  verify(token: string): VerifiedToken {
    const parts = token.split('.');
    if (parts.length !== 7 || parts[0] !== 'v1' || parts[1] !== this.keyId) throw new Error('malformed context');
    const [, , tenantId, userId, flags, exp, mac] = parts as [string, string, string, string, string, string, string];
    if (!UUID.test(tenantId) || !UUID.test(userId) || !/^(-|[ASC]{1,3})$/.test(flags) || !/^[0-9]{1,12}$/.test(exp)) {
      throw new Error('malformed context');
    }
    const expected = Buffer.from(this.mac(parts.slice(0, 6).join('.')), 'hex');
    const given = Buffer.from(mac, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('context signature invalid');
    if (Number(exp) < Math.floor(this.nowMs() / 1000)) throw new Error('context expired');
    return { tenantId, userId, flags, expiresAt: Number(exp) };
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.key).update(payload, 'utf8').digest('hex');
  }
}
