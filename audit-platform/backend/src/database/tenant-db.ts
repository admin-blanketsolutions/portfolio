import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import { ContextSigner } from '../tenancy/context-signer.js';
import { requireTenantContext, type TenantContext } from '../tenancy/tenant-context.js';
import { DomainError, isRetryablePgError, translatePgError } from '../common/errors.js';
import { assertTenantSafeSql } from './sql-guard.js';

export type Isolation = 'read committed' | 'repeatable read' | 'serializable';

export interface TxOptions {
  isolation?: Isolation;
  readOnly?: boolean;
  /** Retries on serialization failure / deadlock (default 2). */
  retries?: number;
}

/**
 * The only handle repositories get. It cannot change the tenant, control the
 * transaction, or outlive it.
 */
export class TenantTx {
  private closed = false;

  constructor(
    private readonly client: pg.PoolClient,
    readonly ctx: TenantContext,
  ) {}

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<pg.QueryResult<R>> {
    if (this.closed) throw new Error('TenantTx used after its transaction ended');
    assertTenantSafeSql(text);
    // queryMode 'extended' forces the extended protocol even with no params,
    // which rejects multi-statement strings ("...; SET ROLE ...").
    const config = { text, values: [...values], queryMode: 'extended' } as unknown as pg.QueryConfig;
    return this.client.query<R>(config);
  }

  /** @internal */
  close(): void {
    this.closed = true;
  }
}

// Detects accidental nested transactions (which would take a second pooled
// connection per request and can deadlock the pool under load).
const inTransaction = new AsyncLocalStorage<true>();

const ISOLATION_SQL: Record<Isolation, string> = {
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

export class TenantDb {
  constructor(
    private readonly pool: pg.Pool,
    private readonly signer: ContextSigner,
    private readonly statementTimeoutMs: number,
  ) {}

  /**
   * Runs `work` in a transaction bound to the ACTIVE tenant context:
   *
   *   BEGIN ISOLATION LEVEL …
   *   SELECT … FROM app.enter_context($token)   -- verify + set, tx-local
   *   …work…
   *   COMMIT
   *
   * Fails closed without a context. The database re-derives tenant and user
   * from the signed token and we cross-check them against the context.
   */
  async transaction<T>(work: (tx: TenantTx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    const ctx = requireTenantContext();
    if (inTransaction.getStore()) {
      throw new Error('Nested TenantDb.transaction(); pass the existing TenantTx instead');
    }
    const maxRetries = opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await inTransaction.run(true, () => this.runOnce(ctx, work, opts));
      } catch (err) {
        if (isRetryablePgError(err) && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 20 * 2 ** attempt + Math.random() * 20));
          continue;
        }
        throw translatePgError(err);
      }
    }
  }

  private async runOnce<T>(ctx: TenantContext, work: (tx: TenantTx) => Promise<T>, opts: TxOptions): Promise<T> {
    const client = await this.pool.connect();
    let destroy = false;
    const tx = new TenantTx(client, ctx);
    try {
      const mode = `${ISOLATION_SQL[opts.isolation ?? 'read committed']}${opts.readOnly ? ' READ ONLY' : ''}`;
      await client.query(`BEGIN ISOLATION LEVEL ${mode}`);
      const entered = await client.query<{ tenant_id: string; user_id: string }>({
        text: `SELECT e.tenant_id, e.user_id, set_config('statement_timeout', $2, true)
                 FROM app.enter_context($1) AS e`,
        values: [this.signer.mint(ctx), String(this.statementTimeoutMs)],
      });
      const row = entered.rows[0];
      if (!row || row.tenant_id !== ctx.tenantId || row.user_id !== ctx.userId) {
        destroy = true;
        throw new DomainError('unauthenticated', 'Session context mismatch.');
      }
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroy = true;
      }
      // A context-leak or signature failure means this connection's state is
      // suspect: never hand it to another request.
      if ((err as { code?: string }).code === '28000') destroy = true;
      throw err;
    } finally {
      tx.close();
      client.release(destroy);
    }
  }
}
