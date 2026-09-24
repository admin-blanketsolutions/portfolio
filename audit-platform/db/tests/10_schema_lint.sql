-- =============================================================================
-- Schema lint: structural invariants that must hold for EVERY table, present
-- and future. Runs in CI on every migration; a new table that forgets RLS or a
-- tenant-scoped FK fails the build before it can leak.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;

DO $$
DECLARE bad text;
BEGIN
  -- L1: RLS enabled AND forced on every app table and partition.
  SELECT string_agg(c.oid::regclass::text, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  ASSERT bad IS NULL, 'L1 tables without ENABLE+FORCE RLS: ' || bad;

  -- L2: tenant_id is the first primary-key column of every app table.
  SELECT string_agg(c.oid::regclass::text, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_constraint pk ON pk.conrelid = c.oid AND pk.contype = 'p'
   WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     AND (pk.oid IS NULL OR (SELECT attname FROM pg_attribute
                              WHERE attrelid = c.oid AND attnum = pk.conkey[1]) <> 'tenant_id');
  ASSERT bad IS NULL, 'L2 tables whose PK does not start with tenant_id: ' || bad;

  -- L3: every FK between app tables is composite and leads with tenant_id on both sides.
  SELECT string_agg(fk.conname || ' on ' || fk.conrelid::regclass::text, ', ') INTO bad
    FROM pg_constraint fk
    JOIN pg_class src ON src.oid = fk.conrelid JOIN pg_namespace sn ON sn.oid = src.relnamespace
    JOIN pg_class dst ON dst.oid = fk.confrelid JOIN pg_namespace dn ON dn.oid = dst.relnamespace
   WHERE fk.contype = 'f' AND sn.nspname = 'app' AND dn.nspname = 'app' AND NOT src.relispartition
     AND fk.conparentid = 0
     AND ( array_length(fk.conkey, 1) < 2
        OR (SELECT attname FROM pg_attribute WHERE attrelid = fk.conrelid  AND attnum = fk.conkey[1])  <> 'tenant_id'
        OR (SELECT attname FROM pg_attribute WHERE attrelid = fk.confrelid AND attnum = fk.confkey[1]) <> 'tenant_id');
  ASSERT bad IS NULL, 'L3 FKs not scoped by tenant_id: ' || bad;

  -- L4: every unique index on app tables includes tenant_id.
  SELECT string_agg(i.indexrelid::regclass::text, ', ') INTO bad
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND i.indisunique AND NOT c.relispartition
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum = ANY (i.indkey));
  ASSERT bad IS NULL, 'L4 unique indexes without tenant_id (existence oracle): ' || bad;

  -- L5: no materialized views anywhere in our schemas (they cannot carry RLS).
  SELECT string_agg(c.oid::regclass::text, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('app', 'platform', 'audit', 'sec') AND c.relkind = 'm';
  ASSERT bad IS NULL, 'L5 materialized views are forbidden: ' || bad;

  -- L6: views, if any, must be security_invoker.
  SELECT string_agg(c.oid::regclass::text, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('app', 'platform', 'audit') AND c.relkind = 'v'
     AND NOT coalesce('security_invoker=true' = ANY (c.reloptions), false);
  ASSERT bad IS NULL, 'L6 views without security_invoker: ' || bad;

  -- L7: SECURITY DEFINER functions pin search_path.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app', 'platform', 'audit', 'sec') AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%');
  ASSERT bad IS NULL, 'L7 SECURITY DEFINER without pinned search_path: ' || bad;

  -- L8: nothing in our schemas is executable by PUBLIC.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app', 'platform', 'audit', 'sec')
     AND has_function_privilege('public', p.oid, 'EXECUTE');
  ASSERT bad IS NULL, 'L8 functions executable by PUBLIC: ' || bad;

  -- L9: no floating-point money.
  SELECT string_agg(a.attrelid::regclass::text || '.' || a.attname, ', ') INTO bad
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
     AND a.atttypid IN ('float4'::regtype, 'float8'::regtype, 'money'::regtype);
  ASSERT bad IS NULL, 'L9 floating-point / money-type columns: ' || bad;
END
$$;

-- Role hygiene.
DO $$
DECLARE bad text; r record;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'audit_app';
  ASSERT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcanlogin, 'audit_app must be NOLOGIN, NOBYPASSRLS';

  SELECT string_agg(c.oid::regclass::text, ', ') INTO bad
    FROM pg_class c WHERE c.relowner = 'audit_app'::regrole;
  ASSERT bad IS NULL, 'audit_app owns objects: ' || bad;

  SELECT string_agg(c.oid::regclass::text, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('app', 'platform', 'audit', 'sec') AND c.relkind IN ('r', 'p')
     AND (has_table_privilege('audit_app', c.oid, 'TRUNCATE')
          OR has_table_privilege('audit_app', c.oid, 'TRIGGER')
          OR has_table_privilege('audit_app', c.oid, 'REFERENCES'));
  ASSERT bad IS NULL, 'audit_app has TRUNCATE/TRIGGER/REFERENCES on: ' || bad;

  SELECT string_agg(c.oid::regclass::text, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relispartition AND has_table_privilege('audit_app', c.oid, 'SELECT');
  ASSERT bad IS NULL, 'audit_app can read partitions directly (bypasses parent RLS): ' || bad;

  ASSERT NOT has_table_privilege('audit_app', 'sec.context_signing_keys', 'SELECT'), 'app can read signing keys';
  ASSERT NOT has_table_privilege('audit_app', 'audit.chain_heads', 'SELECT'), 'app can read chain heads';
  ASSERT NOT has_table_privilege('audit_app', 'audit.events', 'INSERT'), 'app can forge audit events';
  ASSERT NOT has_function_privilege('audit_app', 'sec.mint_ctx(uuid,uuid,text,int)', 'EXECUTE'), 'app can mint ctx in-DB';
END
$$;

ROLLBACK;
