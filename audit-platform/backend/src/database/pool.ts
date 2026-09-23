import pg from 'pg';
import type { AppConfig } from '../config/config.js';

/**
 * Connection pool for the runtime role. Rules that keep pooling tenant-safe:
 *  - the login role is a member of audit_app: NOBYPASSRLS, owns nothing;
 *  - nothing tenant-specific is ever set at SESSION level — the context is
 *    transaction-local (set_config(..., true)), so it cannot survive COMMIT
 *    into the next borrower. This also keeps us compatible with PgBouncer in
 *    transaction-pooling mode;
 *  - app.enter_context() refuses to run if a context is already present on
 *    the connection, turning any leak into a hard, logged failure;
 *  - connections that error mid-transaction are destroyed, not recycled.
 */
export function createPool(config: Pick<AppConfig, 'DATABASE_URL' | 'DB_POOL_MAX'>): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Tenant-neutral session defaults (also set at role level in production).
    options: '-c search_path=app,ext,pg_catalog -c idle_in_transaction_session_timeout=30000',
    application_name: 'audit-api',
  });
  pool.on('error', (err) => {
    // An idle client died; the pool discards it. Never include query text.
    console.error(JSON.stringify({ level: 'error', msg: 'pg pool idle client error', code: (err as { code?: string }).code }));
  });
  return pool;
}
