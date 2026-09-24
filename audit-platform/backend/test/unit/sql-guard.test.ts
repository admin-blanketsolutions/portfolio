import { describe, expect, it } from 'vitest';
import { ForbiddenSqlError, assertTenantSafeSql } from '../../src/database/sql-guard.js';

describe('assertTenantSafeSql', () => {
  it.each([
    'SELECT * FROM app.engagements WHERE id = $1',
    'with x as (select 1) select * from x',
    'INSERT INTO app.workpapers (tenant_id, engagement_id) VALUES ($1, $2) RETURNING id',
    // Multi-line UPDATE whose second line starts with SET must NOT be a false positive.
    `UPDATE app.engagements
        SET stage = $2
      WHERE id = $1`,
    '-- leading comment\nSELECT 1',
    '/* block */ SELECT 1',
  ])('allows %s', (sql) => {
    expect(() => assertTenantSafeSql(sql)).not.toThrow();
  });

  it.each([
    ["SET app.ctx = 'v1...'", /SET/],
    ['SET ROLE postgres', /SET/],
    ['  reset all', /RESET/],
    ['-- sneaky\nSET LOCAL role audit_owner', /SET/],
    ['/* x */ BEGIN', /BEGIN/],
    ['COMMIT', /COMMIT/],
    ["DO $$ BEGIN PERFORM set_config('app.ctx','x',true); END $$", /DO/],
    ["SELECT set_config('app.ctx', $1, true)", /set_config/],
    ["SELECT pg_catalog.set_config ('x', 'y', false)", /set_config/],
    ["SELECT current_setting('app.ctx')", /app\.ctx/],
    ['SELECT * FROM app.enter_context($1)', /enter_context/],
    ["COPY app.users TO PROGRAM 'curl evil'", /COPY/],
    ["SELECT pg_read_file('/etc/passwd')", /file access/],
    ['TRUNCATE app.audit', /TRUNCATE/],
    ['', /empty/],
  ])('rejects %s', (sql, reason) => {
    expect(() => assertTenantSafeSql(sql)).toThrow(ForbiddenSqlError);
    expect(() => assertTenantSafeSql(sql)).toThrow(reason);
  });
});
