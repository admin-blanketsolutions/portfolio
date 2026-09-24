-- =============================================================================
-- Cross-tenant isolation, exercised as the real runtime role (audit_app).
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE audit_app;

-- T1  No context => every table is empty (fail closed), including tenants.
DO $$
DECLARE r record; n bigint;
BEGIN
  PERFORM test.logout();
  FOR r IN SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_tables
            WHERE schemaname = 'app' AND tablename !~ '_p[0-9]+$' LOOP
    EXECUTE 'SELECT count(*) FROM ' || r.t INTO n;
    ASSERT n = 0, format('T1 %s visible without context (%s rows)', r.t, n);
  END LOOP;
  SELECT count(*) INTO n FROM platform.tenants;
  ASSERT n = 0, 'T1 tenants visible without context';
  SELECT count(*) INTO n FROM audit.events;
  ASSERT n = 0, 'T1 audit events visible without context';
END
$$;

-- T2  A firm admin sees exactly one tenant everywhere.
DO $$
DECLARE r record; n bigint;
BEGIN
  PERFORM test.login('alpha', 'admin');
  FOR r IN SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_tables
            WHERE schemaname = 'app' AND tablename !~ '_p[0-9]+$' LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE tenant_id <> %L', r.t, test.tenant('alpha')) INTO n;
    ASSERT n = 0, format('T2 %s leaks %s foreign rows', r.t, n);
  END LOOP;
  SELECT count(*) INTO n FROM platform.tenants;
  ASSERT n = 1, 'T2 tenant row count should be 1, got ' || n;
  SELECT count(*) INTO n FROM app.users;
  ASSERT n = 9, 'T2 expected 9 alpha users (8 fixtures + the ingestion principal), got ' || n;
END
$$;

-- T3  Writes into another tenant are rejected by WITH CHECK.
DO $$
BEGIN
  PERFORM test.login('alpha', 'manager');
  PERFORM test.expect_error(format(
    $q$INSERT INTO app.clients (tenant_id, legal_name, registration_number, country_code, functional_currency,
                                fiscal_year_end_month)
       VALUES (%L, 'Injected', 'X-1', 'JO', 'JOD', 12)$q$, test.tenant('beta')),
    'row-level security');
END
$$;

-- T4  Updates/deletes aimed at another tenant affect zero rows (no error oracle).
DO $$
DECLARE n bigint;
BEGIN
  PERFORM test.login('alpha', 'admin');
  UPDATE app.clients SET legal_name = 'pwned' WHERE tenant_id = test.tenant('beta');
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'T4 cross-tenant UPDATE touched rows';
  UPDATE app.users SET display_name = 'pwned' WHERE id = test.uid('beta', 'partner');
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'T4 cross-tenant UPDATE by id touched rows';
END
$$;

-- T5  Composite FKs: an own-tenant row cannot reference a foreign parent.
DO $$
DECLARE beta_client uuid;
BEGIN
  PERFORM test.login('beta', 'manager');
  SELECT id INTO beta_client FROM app.clients LIMIT 1;
  PERFORM test.login('alpha', 'manager');
  PERFORM test.expect_error(format(
    $q$INSERT INTO app.engagements (tenant_id, client_id, code, period_start, period_end, reporting_currency)
       VALUES (%L, %L, 'ENG-X', '2025-01-01', '2025-12-31', 'JOD')$q$, test.tenant('alpha'), beta_client),
    'foreign key');
  -- Even a service principal (no ethical wall) cannot attach content to a foreign engagement.
  PERFORM test.login('alpha', 'svc');
  PERFORM test.expect_error(format(
    $q$INSERT INTO app.workpapers (tenant_id, engagement_id, ref_code, title, phase)
       VALUES (%L, %L, 'A-100', 'Cross-tenant', 'fieldwork')$q$, test.tenant('alpha'), test.eng('beta', 'ENG-B')),
    'engagement not found|foreign key');
END
$$;

-- T6  Forged / expired / malformed / unknown-key contexts are rejected loudly.
DO $$
DECLARE tok text; parts text[];
BEGIN
  PERFORM test.login('alpha', 'admin');
  tok := current_setting('app.ctx');
  parts := string_to_array(tok, '.');

  -- Swap in beta's tenant id, keep alpha's signature.
  parts[3] := test.tenant('beta')::text;
  PERFORM set_config('app.ctx', array_to_string(parts, '.'), false);
  PERFORM test.expect_error('SELECT count(*) FROM app.clients', 'signature invalid');

  -- Escalate flags from admin to service principal.
  parts := string_to_array(tok, '.');
  parts[5] := 'S';
  PERFORM set_config('app.ctx', array_to_string(parts, '.'), false);
  PERFORM test.expect_error('SELECT count(*) FROM app.clients', 'signature invalid');

  -- Extend expiry.
  parts := string_to_array(tok, '.');
  parts[6] := '9999999999';
  PERFORM set_config('app.ctx', array_to_string(parts, '.'), false);
  PERFORM test.expect_error('SELECT count(*) FROM app.clients', 'signature invalid');

  PERFORM set_config('app.ctx', 'v1.test-k1.not-a-uuid', false);
  PERFORM test.expect_error('SELECT count(*) FROM app.clients', 'malformed');

  parts := string_to_array(tok, '.');
  parts[2] := 'rogue-key';
  PERFORM set_config('app.ctx', array_to_string(parts, '.'), false);
  PERFORM test.expect_error('SELECT count(*) FROM app.clients', 'key unknown');

  PERFORM test.login('alpha', 'admin', -5);
  PERFORM test.expect_error('SELECT count(*) FROM app.clients', 'expired');
END
$$;

-- T7  Partitions and secrets are not reachable directly.
DO $$
BEGIN
  PERFORM test.login('alpha', 'admin');
  PERFORM test.expect_error('SELECT count(*) FROM app.tb_lines_p0', 'permission denied');
  PERFORM test.expect_error('SELECT * FROM sec.context_signing_keys', 'permission denied');
  PERFORM test.expect_error('SELECT * FROM audit.chain_heads', 'permission denied');
  PERFORM test.expect_error($q$SELECT sec.mint_ctx(gen_random_uuid(), gen_random_uuid(), 'A')$q$, 'permission denied');
END
$$;

-- T8  No global-uniqueness oracle: alpha can register an e-mail that exists in beta.
DO $$
BEGIN
  PERFORM test.login('alpha', 'admin');
  INSERT INTO app.users (tenant_id, idp_subject, email, display_name, user_kind, professional_rank)
  VALUES (test.tenant('alpha'), 'idp|dup', 'partner@beta.test', 'Dup', 'staff', 'associate');
END
$$;

ROLLBACK;
