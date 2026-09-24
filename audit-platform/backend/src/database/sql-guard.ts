/**
 * Defence-in-depth lint for SQL issued through a tenant transaction.
 *
 * The real boundary is the database (signed context + RLS + triggers). This
 * guard catches the application-side mistakes that would weaken it: code that
 * touches the session context, controls transactions behind TenantDb's back,
 * or runs statements that can smuggle arbitrary SQL. Because every query is
 * sent with the EXTENDED protocol (one statement per message), checking the
 * leading keyword is sufficient.
 */
export class ForbiddenSqlError extends Error {
  constructor(reason: string) {
    super(`SQL rejected by tenant guard: ${reason}`);
    this.name = 'ForbiddenSqlError';
  }
}

const FORBIDDEN_LEADING = new Set([
  'SET', 'RESET', 'DISCARD',                               // session state (incl. SET ROLE / app.ctx)
  'BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT',  // transaction control belongs to TenantDb
  'SAVEPOINT', 'RELEASE', 'PREPARE',
  'DO', 'CALL', 'EXECUTE', 'DEALLOCATE',                   // anonymous / dynamic code
  'COPY', 'LISTEN', 'UNLISTEN', 'NOTIFY', 'LOAD',
  'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'TRUNCATE', 'VACUUM', 'CLUSTER', 'REINDEX', 'SECURITY',
]);

const FORBIDDEN_ANYWHERE: Array<[RegExp, string]> = [
  [/\bset_config\s*\(/i, 'set_config() is reserved for TenantDb'],
  [/\bapp\s*\.\s*ctx\b/i, 'the app.ctx setting is reserved for TenantDb'],
  [/\benter_context\s*\(/i, 'enter_context() is reserved for TenantDb'],
  [/\bpg_(read|write)_(binary_)?file\b|\blo_(import|export)\b/i, 'server file access'],
  [/\bdblink\b|\bpostgres_fdw\b/i, 'cross-database access'],
];

/** Strip leading whitespace and SQL comments, return the first keyword. */
function leadingKeyword(sql: string): string {
  let s = sql;
  for (;;) {
    const trimmed = s.replace(/^\s+/, '');
    if (trimmed.startsWith('--')) {
      const nl = trimmed.indexOf('\n');
      s = nl === -1 ? '' : trimmed.slice(nl + 1);
    } else if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      s = end === -1 ? '' : trimmed.slice(end + 2);
    } else {
      s = trimmed;
      break;
    }
  }
  return (/^[A-Za-z]+/.exec(s)?.[0] ?? '').toUpperCase();
}

export function assertTenantSafeSql(sql: string): void {
  const kw = leadingKeyword(sql);
  if (kw === '') throw new ForbiddenSqlError('empty statement');
  if (FORBIDDEN_LEADING.has(kw)) throw new ForbiddenSqlError(`${kw} statements are not allowed`);
  for (const [re, reason] of FORBIDDEN_ANYWHERE) {
    if (re.test(sql)) throw new ForbiddenSqlError(reason);
  }
}
