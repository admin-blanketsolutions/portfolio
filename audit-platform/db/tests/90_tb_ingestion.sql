-- =============================================================================
-- TB ingestion (V0010): uploads, the ingestion service principal, provenance
-- of mapping suggestions, postable-only targets, firm mapping rules.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;

-- Test-only: "log in" as a tenant's ingestion service principal (the backend's
-- worker mints this context with the real signing key).
CREATE FUNCTION test.login_ingestion(p_slug text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ext, pg_temp AS $$
BEGIN
  PERFORM set_config('app.ctx',
    sec.mint_ctx(test.tenant(p_slug), platform.service_principal_id(test.tenant(p_slug), 'system:tb-ingestion'), 'S', 600),
    false);
  RETURN p_slug || '/system:tb-ingestion';
END
$$;
GRANT EXECUTE ON FUNCTION test.login_ingestion(text) TO audit_app;

SET LOCAL ROLE audit_app;
CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);

-- ---------------------------------------------------------------------------
-- Uploads
-- ---------------------------------------------------------------------------
DO $$
DECLARE t uuid := test.tenant('alpha'); e uuid := test.eng('alpha', 'ENG-A'); imp uuid; r record;
        k text := format('tenants/%s/engagements/%s/tb/%s', test.tenant('alpha'), test.eng('alpha', 'ENG-A'), gen_random_uuid());
BEGIN
  PERFORM test.login('alpha', 'junior');
  -- U1 A staff member of the engagement records an upload; system fields are reset.
  INSERT INTO app.tb_imports (tenant_id, engagement_id, as_of_date, currency, source_object_key, source_sha256,
                              source_filename, source_format, source_size_bytes, status, failure_code,
                              trial_balance_id, parser_version, created_by)
  VALUES (t, e, DATE '2025-12-31', 'JOD', k, ext.digest('tb-bytes', 'sha256'), 'TB 2025.xlsx', 'xlsx', 1234,
          'received', NULL, NULL, 'forged', test.uid('alpha', 'partner'))
  RETURNING id INTO imp;
  SELECT * INTO r FROM app.tb_imports WHERE id = imp;
  ASSERT r.created_by = test.uid('alpha', 'junior') AND r.parser_version IS NULL AND r.status = 'received',
         'U1 upload record must be server-stamped';
  INSERT INTO ids VALUES ('imp', imp);

  -- U2 Keys outside the tenant/engagement tb/ prefix are refused.
  PERFORM test.expect_error(format(
    $q$INSERT INTO app.tb_imports (tenant_id, engagement_id, as_of_date, currency, source_object_key, source_sha256,
                                   source_filename, source_format, source_size_bytes)
       VALUES (%L, %L, '2025-12-31', 'JOD', %L, ext.digest('x', 'sha256'), 'x.csv', 'csv', 1)$q$,
    t, e, format('tenants/%s/engagements/%s/evidence/x', t, e)), 'tb_imports_check|violates check');
  -- U3 A staff member cannot move the import along or attach a TB.
  PERFORM test.expect_error(format($q$UPDATE app.tb_imports SET status = 'processing' WHERE id = %L$q$, imp),
                            'managed by the ingestion service');
  -- U4 No deletes.
  PERFORM test.expect_error(format($q$DELETE FROM app.tb_imports WHERE id = %L$q$, imp), 'permission denied|not permitted');
END
$$;

-- U5 Walls: non-members, client contacts, other tenants and service principals cannot upload.
DO $$
DECLARE t uuid := test.tenant('alpha'); e uuid := test.eng('alpha', 'ENG-A'); n int;
        stmt text := format(
          $q$INSERT INTO app.tb_imports (tenant_id, engagement_id, as_of_date, currency, source_object_key, source_sha256,
                                         source_filename, source_format, source_size_bytes)
             VALUES (%L, %L, '2025-12-31', 'JOD', %L, ext.digest('x', 'sha256'), 'x.csv', 'csv', 1)$q$,
          test.tenant('alpha'), test.eng('alpha', 'ENG-A'),
          format('tenants/%s/engagements/%s/tb/x', test.tenant('alpha'), test.eng('alpha', 'ENG-A')));
BEGIN
  PERFORM test.login('alpha', 'junior2');
  PERFORM test.expect_error(stmt, 'row-level security');
  SELECT count(*) INTO n FROM app.tb_imports;
  ASSERT n = 0, 'U5 non-member sees no uploads';
  PERFORM test.login('alpha', 'client');
  PERFORM test.expect_error(stmt, 'row-level security|uploaded by engagement staff');
  PERFORM test.login('beta', 'manager');
  PERFORM test.expect_error(stmt, 'row-level security|engagement not found');
  SELECT count(*) INTO n FROM app.tb_imports;
  ASSERT n = 0, 'U5 other tenant sees no uploads';
  PERFORM test.login_ingestion('alpha');
  PERFORM test.expect_error(stmt, 'uploaded by engagement staff');
END
$$;

-- ---------------------------------------------------------------------------
-- Processing by the ingestion principal
-- ---------------------------------------------------------------------------
DO $$
DECLARE t uuid := test.tenant('alpha'); e uuid := test.eng('alpha', 'ENG-A'); imp uuid := (SELECT v FROM ids WHERE k = 'imp');
        i record; tb uuid; other uuid;
BEGIN
  PERFORM test.login_ingestion('alpha');
  SELECT * INTO i FROM app.tb_imports WHERE id = imp;
  ASSERT FOUND, 'P0 the service principal can see the upload';

  UPDATE app.tb_imports SET status = 'processing' WHERE id = imp;
  PERFORM test.expect_error(format($q$UPDATE app.tb_imports SET source_filename = 'renamed.xlsx' WHERE id = %L$q$, imp),
                            'provenance is immutable');
  PERFORM test.expect_error(format($q$UPDATE app.tb_imports SET status = 'received' WHERE id = %L$q$, imp),
                            'illegal import transition');

  -- A TB built from a DIFFERENT file cannot be attached to this import.
  INSERT INTO app.trial_balances (tenant_id, engagement_id, version, as_of_date, currency, source_object_key,
                                  source_sha256, source_filename, parser_version, ctl_line_count, ctl_sum_debit, ctl_sum_credit)
  VALUES (t, e, 1, i.as_of_date, i.currency, i.source_object_key, ext.digest('other-bytes', 'sha256'), i.source_filename,
          'tb-parser@0.1.0', 0, 0, 0) RETURNING id INTO other;
  UPDATE app.trial_balances SET status = 'imported' WHERE id = other;
  PERFORM test.expect_error(format($q$UPDATE app.tb_imports SET status = 'imported', trial_balance_id = %L WHERE id = %L$q$,
                                   other, imp), 'built from its own file');

  -- The real one.
  INSERT INTO app.trial_balances (tenant_id, engagement_id, version, as_of_date, currency, source_object_key,
                                  source_sha256, source_filename, parser_version, ctl_line_count, ctl_sum_debit, ctl_sum_credit)
  VALUES (t, e, 2, i.as_of_date, i.currency, i.source_object_key, i.source_sha256, i.source_filename,
          'tb-parser@0.1.0', 3, 100, 100) RETURNING id INTO tb;
  INSERT INTO app.tb_lines (tenant_id, trial_balance_id, engagement_id, line_no, client_account_code,
                            client_account_name, client_account_name_norm, closing_balance)
  VALUES (t, tb, e, 1, '101', 'Cash', 'cash', 100), (t, tb, e, 2, '301', 'Capital', 'capital', -60),
         (t, tb, e, 3, '401', 'Sales', 'sales', -40);
  PERFORM test.expect_error(format($q$UPDATE app.tb_imports SET status = 'imported', trial_balance_id = %L WHERE id = %L$q$,
                                   tb, imp), 'built from its own file');   -- TB still importing
  UPDATE app.trial_balances SET status = 'imported' WHERE id = tb;
  UPDATE app.tb_imports SET status = 'imported', trial_balance_id = tb, parser_version = 'tb-parser@0.1.0',
                            report = '{"warnings": []}' WHERE id = imp;
  SELECT * INTO i FROM app.tb_imports WHERE id = imp;
  ASSERT i.completed_at IS NOT NULL AND i.trial_balance_id = tb, 'P1 import bound to its TB';
  INSERT INTO ids VALUES ('tb', tb);

  -- P2 Only the mapping summary may change afterwards.
  UPDATE app.tb_imports SET mapping_summary = '{"rule": 2}' WHERE id = imp;
  PERFORM test.expect_error(format($q$UPDATE app.tb_imports SET report = '{}' WHERE id = %L$q$, imp),
                            'results are immutable');
  PERFORM test.expect_error(format($q$UPDATE app.tb_imports SET status = 'failed', failure_code = 'x' WHERE id = %L$q$, imp),
                            'illegal import transition');
END
$$;

-- ---------------------------------------------------------------------------
-- Mapping provenance & postable targets
-- ---------------------------------------------------------------------------
DO $$
DECLARE t uuid := test.tenant('alpha'); e uuid := test.eng('alpha', 'ENG-A'); tb uuid := (SELECT v FROM ids WHERE k = 'tb');
        line1 uuid; ins text;
BEGIN
  PERFORM test.login_ingestion('alpha');
  SELECT id INTO line1 FROM app.tb_lines WHERE trial_balance_id = tb AND line_no = 1;
  ins := $q$INSERT INTO app.account_mappings (tenant_id, engagement_id, trial_balance_id, tb_line_id, coa_account_id,
                                              source, model_ref, status) VALUES (%L, %L, %L, %L, %L, %L, %L, %L)$q$;

  -- M6 A mapping to a header (non-postable) account is refused, whoever proposes it.
  PERFORM test.expect_error(format(ins, t, e, tb, line1, test.coa('alpha', 'BSA'), 'rule', NULL, 'suggested'), 'postable');
  -- M7 The service principal cannot pass its output off as a human's.
  PERFORM test.expect_error(format(ins, t, e, tb, line1, test.coa('alpha', '1000'), 'manual', NULL, 'suggested'),
                            'cannot record a manual mapping');
  EXECUTE format(ins, t, e, tb, line1, test.coa('alpha', '1000'), 'carried_forward', NULL, 'suggested');

  -- M8 ... and a human cannot forge "machine" provenance.
  PERFORM test.login('alpha', 'senior');
  PERFORM test.expect_error(format(ins, t, e, tb, line1, test.coa('alpha', '1000'), 'llm', 'fake-model', 'suggested'),
                            'only by a service principal');
  PERFORM test.expect_error(format(ins, t, e, tb, line1, test.coa('alpha', 'BSA'), 'manual', NULL, 'accepted'), 'postable');
  UPDATE app.account_mappings SET status = 'accepted' WHERE tb_line_id = line1 AND source = 'carried_forward';
  ASSERT (SELECT decided_by FROM app.account_mappings WHERE tb_line_id = line1 AND status = 'accepted')
         = test.uid('alpha', 'senior'), 'M8 decision attributed to the human';
END
$$;

-- ---------------------------------------------------------------------------
-- Firm mapping rules
-- ---------------------------------------------------------------------------
DO $$
DECLARE t uuid := test.tenant('alpha'); n int;
BEGIN
  PERFORM test.login('alpha', 'admin');
  INSERT INTO app.mapping_rules (tenant_id, priority, kind, pattern, pattern_to, coa_account_id, description)
  VALUES (t, 10, 'code_range', '1000', '1099', test.coa('alpha', '1000'), 'Cash and bank accounts'),
         (t, 20, 'name_contains', 'رواتب', NULL, test.coa('alpha', '5100'), 'Salaries');
  -- R1 Ranges need an upper bound; other kinds must not have one.
  PERFORM test.expect_error(format($q$INSERT INTO app.mapping_rules (tenant_id, priority, kind, pattern, coa_account_id)
                                      VALUES (%L, 1, 'code_range', '1', %L)$q$, t, test.coa('alpha', '1000')),
                            'violates check');
  -- R2 Rules target postable accounts only.
  PERFORM test.expect_error(format($q$INSERT INTO app.mapping_rules (tenant_id, priority, kind, pattern, coa_account_id)
                                      VALUES (%L, 1, 'code_prefix', '1', %L)$q$, t, test.coa('alpha', 'BS')),
                            'postable');
  -- R3 Rules are retired, not deleted.
  PERFORM test.expect_error('DELETE FROM app.mapping_rules', 'permission denied|not permitted');

  -- R4 Only firm admins write rules; staff and the service principal read them; clients do not.
  PERFORM test.login('alpha', 'manager');
  PERFORM test.expect_error(format($q$INSERT INTO app.mapping_rules (tenant_id, priority, kind, pattern, coa_account_id)
                                      VALUES (%L, 1, 'code_prefix', '4', %L)$q$, t, test.coa('alpha', '4000')),
                            'row-level security');
  UPDATE app.mapping_rules SET is_active = false;
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'R4 non-admin updates must match no rows';
  SELECT count(*) INTO n FROM app.mapping_rules;
  ASSERT n = 2, 'R4 staff read rules';
  PERFORM test.login_ingestion('alpha');
  SELECT count(*) INTO n FROM app.mapping_rules;
  ASSERT n = 2, 'R4 the ingestion principal reads rules';
  PERFORM test.login('alpha', 'client');
  SELECT count(*) INTO n FROM app.mapping_rules;
  ASSERT n = 0, 'R4 client contacts do not see firm rules';
  PERFORM test.login('beta', 'admin');
  SELECT count(*) INTO n FROM app.mapping_rules;
  ASSERT n = 0, 'R4 other tenants do not see rules';
END
$$;

-- ---------------------------------------------------------------------------
-- Tamper evidence: uploads and rules are hash-chained like every audited table.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.login('alpha', 'admin');
  ASSERT (SELECT count(*) FROM audit.events WHERE table_name = 'app.tb_imports') >= 4, 'C8 upload lifecycle chained';
  ASSERT (SELECT count(*) FROM audit.events WHERE table_name = 'app.mapping_rules') = 2, 'C8 rules chained';
  ASSERT (SELECT ok FROM audit.verify_chain(test.tenant('alpha'))), 'C8 chain verifies';
END
$$;

ROLLBACK;
