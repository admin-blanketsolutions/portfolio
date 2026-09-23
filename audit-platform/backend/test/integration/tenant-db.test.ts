import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../../src/common/errors.js';
import { decodeSecret } from '../../src/config/config.js';
import { ForbiddenSqlError } from '../../src/database/sql-guard.js';
import { TenantDb } from '../../src/database/tenant-db.js';
import { ContextSigner } from '../../src/tenancy/context-signer.js';
import { MissingTenantContextError, runWithTenantContext, type TenantContext } from '../../src/tenancy/tenant-context.js';
import { APP_URL, TEST_KEY, TEST_KEY_ID, enabled, loadFixture, type Fixture } from './env.js';

describe.skipIf(!enabled)('TenantDb against PostgreSQL (RLS + signed context)', () => {
  let pool: pg.Pool;
  let db: TenantDb;
  let fx: Fixture;

  const ctxFor = (who: string, over: Partial<TenantContext> = {}): TenantContext => {
    const u = fx.users[who]!;
    return {
      tenantId: u.tenantId,
      tenantSlug: who.split('@')[1] + '-audit',
      userId: u.id,
      kind: 'staff',
      isFirmAdmin: false,
      homeRegion: 'me-central-1',
      requestId: 'it-00000001',
      ...over,
    };
  };
  const codes = (c: TenantContext) =>
    runWithTenantContext(c, () => db.transaction(async (tx) =>
      (await tx.query<{ code: string }>('SELECT code FROM app.engagements ORDER BY code')).rows.map((r) => r.code)));

  beforeAll(async () => {
    fx = await loadFixture();
    // Deliberately tiny pool: forces heavy connection reuse across tenants.
    pool = new pg.Pool({ connectionString: APP_URL, max: 3 });
    db = new TenantDb(pool, new ContextSigner(TEST_KEY_ID, decodeSecret(TEST_KEY), 60), 5_000);
  });
  afterAll(async () => { await pool?.end(); });

  it('accepts contexts minted in TypeScript (HMAC compatible with sec.verified_ctx)', async () => {
    expect(await codes(ctxFor('manager@alpha'))).toEqual(['ENG-A', 'ENG-WALL']);
    expect(await codes(ctxFor('manager@beta'))).toEqual(['ENG-B']);
  });

  it('fails closed with no context', async () => {
    await expect(db.transaction(async () => 1)).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('never leaks context across pooled connections under concurrency', async () => {
    const who = ['manager@alpha', 'manager@beta', 'client@alpha', 'client@beta'];
    const expected: Record<string, string[]> = {
      'manager@alpha': ['ENG-A', 'ENG-WALL'], 'manager@beta': ['ENG-B'],
      'client@alpha': ['ENG-A'], 'client@beta': ['ENG-B'],
    };
    const runs = Array.from({ length: 60 }, (_, i) => {
      const w = who[i % who.length]!;
      const c = ctxFor(w, w.startsWith('client') ? { kind: 'client_contact' } : {});
      return codes(c).then((got) => ({ w, got }));
    });
    for (const { w, got } of await Promise.all(runs)) expect(got).toEqual(expected[w]);

    // After all that reuse, an idle connection carries no tenant context.
    const { rows } = await pool.query<{ ctx: string | null }>("SELECT current_setting('app.ctx', true) AS ctx");
    expect(rows[0]!.ctx ?? '').toBe('');
    const leaked = await pool.query('SELECT count(*)::int AS n FROM app.engagements');
    expect(leaked.rows[0].n).toBe(0);
  });

  it('rejects a context signed with the wrong key and discards the connection', async () => {
    const rogue = new TenantDb(pool, new ContextSigner(TEST_KEY_ID, Buffer.alloc(40, 1), 60), 5_000);
    const err = await runWithTenantContext(ctxFor('manager@alpha'), () => rogue.transaction(async () => 1)).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('unauthenticated');
  });

  it('blocks context tampering from repository code, in the app and in the database', async () => {
    const c = ctxFor('manager@alpha');
    await expect(runWithTenantContext(c, () => db.transaction((tx) => tx.query("SELECT set_config('app.ctx', 'x', true)"))))
      .rejects.toBeInstanceOf(ForbiddenSqlError);
    // Multi-statement smuggling is refused by the extended protocol itself.
    const err = await runWithTenantContext(c, () => db.transaction((tx) => tx.query('SELECT 1; RESET ROLE'))).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
  });

  it('maps RLS and trigger failures to safe domain errors', async () => {
    const c = ctxFor('manager@alpha');
    const rls = await runWithTenantContext(c, () => db.transaction((tx) =>
      tx.query(`INSERT INTO app.clients (tenant_id, legal_name, registration_number, country_code, functional_currency, fiscal_year_end_month)
                VALUES ($1, 'x', 'y', 'JO', 'JOD', 12)`, [fx.tenants.beta]))).catch((e) => e);
    expect(rls).toMatchObject({ code: 'forbidden', message: 'You are not permitted to perform this action.' });

    const trig = await runWithTenantContext(c, () => db.transaction((tx) =>
      tx.query(`UPDATE app.engagements SET stage = 'archived' WHERE id = $1`, [fx.engagements['ENG-A']]))).catch((e) => e);
    expect(trig).toMatchObject({ code: 'conflict' });
    expect((trig as DomainError).message).toMatch(/illegal stage transition/);
  });

  it('rolls back on error: nothing half-written survives', async () => {
    const c = ctxFor('manager@alpha');
    await runWithTenantContext(c, () => db.transaction(async (tx) => {
      await tx.query(`INSERT INTO app.workpapers (tenant_id, engagement_id, ref_code, title, phase)
                      VALUES ($1, $2, 'R-900', 'rollback probe', 'fieldwork')`, [fx.tenants.alpha, fx.engagements['ENG-A']]);
      throw new Error('boom');
    })).catch(() => undefined);
    const n = await runWithTenantContext(c, () => db.transaction(async (tx) =>
      (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.workpapers WHERE ref_code = 'R-900'`)).rows[0]!.n));
    expect(n).toBe(0);
  });

  it('refuses nested transactions and use of a TenantTx after it ends', async () => {
    const c = ctxFor('manager@alpha');
    await expect(runWithTenantContext(c, () => db.transaction(() => db.transaction(async () => 1)))).rejects.toThrow(/Nested/);
    let escaped: { query: (s: string) => Promise<unknown> } | undefined;
    await runWithTenantContext(c, () => db.transaction(async (tx) => { escaped = tx; }));
    await expect(escaped!.query('SELECT 1')).rejects.toThrow(/after its transaction ended/);
  });
});
