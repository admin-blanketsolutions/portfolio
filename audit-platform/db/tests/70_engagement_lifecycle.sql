-- =============================================================================
-- Engagement lifecycle: stage gates (ISA 220/230/320) and the archive lock.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE audit_app;

-- G1  Who may create engagements (NULL-safe: service principals have no rank).
DO $$
DECLARE ins text := format(
  $q$INSERT INTO app.engagements (tenant_id, client_id, code, period_start, period_end, reporting_currency)
     SELECT %L, id, 'ENG-NEW', '2026-01-01', '2026-12-31', 'JOD' FROM app.clients LIMIT 1$q$, test.tenant('alpha'));
BEGIN
  PERFORM test.login('alpha', 'junior');
  PERFORM test.expect_error(ins, 'only managers');
  PERFORM test.login('alpha', 'svc');
  PERFORM test.expect_error(ins, 'only managers');
  PERFORM test.login('alpha', 'client');
  PERFORM test.expect_error(ins, 'only managers|row-level security');
END
$$;

-- G2  Planning -> fieldwork requires materiality and an engagement partner.
DO $$
DECLARE e uuid;
BEGIN
  PERFORM test.login('alpha', 'manager');
  INSERT INTO app.engagements (tenant_id, client_id, code, period_start, period_end, reporting_currency, stage)
  SELECT test.tenant('alpha'), id, 'ENG-NEW', DATE '2026-01-01', DATE '2026-12-31', 'JOD', 'archived'  -- spoofed
    FROM app.clients WHERE registration_number = 'REG-alpha'
  RETURNING id INTO e;
  ASSERT (SELECT stage FROM app.engagements WHERE id = e) = 'planning', 'G2 new engagements start in planning';
  INSERT INTO app.engagement_members (tenant_id, engagement_id, user_id, role)
  VALUES (test.tenant('alpha'), e, test.uid('alpha', 'manager'), 'manager');

  PERFORM test.expect_error(format($q$UPDATE app.engagements SET stage = 'fieldwork' WHERE id = %L$q$, e), 'materiality');
  UPDATE app.engagements SET overall_materiality = 10000, performance_materiality = 7500,
                             clearly_trivial_threshold = 500 WHERE id = e;
  PERFORM test.expect_error(format($q$UPDATE app.engagements SET stage = 'fieldwork' WHERE id = %L$q$, e),
                            'engagement partner must be assigned');
  PERFORM test.expect_error(format($q$UPDATE app.engagements SET stage = 'review' WHERE id = %L$q$, e),
                            'illegal stage transition');
  PERFORM test.expect_error(format($q$UPDATE app.engagements SET performance_materiality = 20000 WHERE id = %L$q$, e),
                            'check constraint');   -- PM may not exceed overall materiality
END
$$;

-- G3  Completion gates, then archive.
DO $$
DECLARE t uuid := test.tenant('alpha'); e uuid := test.eng('alpha', 'ENG-A'); tb uuid; wp uuid; v uuid; h bytea;
BEGIN
  PERFORM test.login('alpha', 'manager');
  UPDATE app.engagements SET stage = 'review' WHERE id = e;
  UPDATE app.engagements SET stage = 'reporting' WHERE id = e;
  PERFORM test.expect_error(format($q$UPDATE app.engagements SET period_end = '2025-11-30' WHERE id = %L$q$, e), 'frozen');
  PERFORM test.expect_error(format($q$UPDATE app.engagements SET stage = 'completed' WHERE id = %L$q$, e), 'report_date');
  UPDATE app.engagements SET report_date = DATE '2026-03-15' WHERE id = e;
  ASSERT (SELECT assembly_deadline FROM app.engagements WHERE id = e) = DATE '2026-05-14', 'G3 ISA 230 assembly deadline';
  PERFORM test.expect_error(format($q$UPDATE app.engagements SET stage = 'completed' WHERE id = %L$q$, e), 'no locked trial balance');

  -- Minimal locked TB.
  PERFORM test.login('alpha', 'svc');
  INSERT INTO app.trial_balances (tenant_id, engagement_id, version, as_of_date, currency, source_object_key,
                                  source_sha256, source_filename, parser_version, ctl_line_count, ctl_sum_debit, ctl_sum_credit)
  VALUES (t, e, 1, DATE '2025-12-31', 'JOD', format('tenants/%s/engagements/%s/tb/v1.csv', t, e),
          ext.digest('csv', 'sha256'), 'tb.csv', 'tb-parser@1.4.0', 2, 10, 10) RETURNING id INTO tb;
  INSERT INTO app.tb_lines (tenant_id, trial_balance_id, engagement_id, line_no, client_account_code, client_account_name,
                            client_account_name_norm, closing_balance)
  VALUES (t, tb, e, 1, '1', 'Cash', 'cash', 10), (t, tb, e, 2, '2', 'Capital', 'capital', -10);
  UPDATE app.trial_balances SET status = 'imported' WHERE id = tb;
  PERFORM test.login('alpha', 'senior');
  INSERT INTO app.account_mappings (tenant_id, engagement_id, trial_balance_id, tb_line_id, coa_account_id, source, status)
  SELECT t, e, tb, l.id, test.coa('alpha', CASE l.line_no WHEN 1 THEN '1000' ELSE '3000' END), 'manual', 'accepted'
    FROM app.tb_lines l WHERE l.trial_balance_id = tb;
  UPDATE app.trial_balances SET status = 'locked' WHERE id = tb;

  -- An unsigned workpaper blocks completion.
  PERFORM test.login('alpha', 'junior');
  INSERT INTO app.workpapers (tenant_id, engagement_id, ref_code, title, phase)
  VALUES (t, e, 'B-100', 'Completion memo', 'reporting') RETURNING id INTO wp;
  INSERT INTO app.workpaper_versions (tenant_id, workpaper_id, engagement_id, content, content_sha256)
  VALUES (t, wp, e, '{"memo":"All matters resolved"}', ext.digest('x', 'sha256')) RETURNING id, content_sha256 INTO v, h;
  PERFORM test.login('alpha', 'manager');
  PERFORM test.expect_error(format($q$UPDATE app.engagements SET stage = 'completed' WHERE id = %L$q$, e),
                            'lack partner approval');

  PERFORM test.login('alpha', 'junior');
  INSERT INTO app.workpaper_signoffs (tenant_id, workpaper_id, engagement_id, version_id, level, content_sha256)
  VALUES (t, wp, e, v, 'preparer', h);
  PERFORM test.login('alpha', 'senior');
  INSERT INTO app.workpaper_signoffs (tenant_id, workpaper_id, engagement_id, version_id, level, content_sha256, step_up_assertion)
  VALUES (t, wp, e, v, 'reviewer', h, '{"webauthn":"ok"}');
  PERFORM test.login('alpha', 'partner');
  INSERT INTO app.workpaper_signoffs (tenant_id, workpaper_id, engagement_id, version_id, level, content_sha256, step_up_assertion)
  VALUES (t, wp, e, v, 'partner', h, '{"webauthn":"ok"}');

  -- An open AJE blocks completion.
  PERFORM test.login('alpha', 'junior');
  INSERT INTO app.adjusting_entries (tenant_id, engagement_id, entry_type, description, effective_date)
  VALUES (t, e, 'AJE', 'Forgotten draft entry', DATE '2025-12-31');
  PERFORM test.login('alpha', 'manager');
  PERFORM test.expect_error(format($q$UPDATE app.engagements SET stage = 'completed' WHERE id = %L$q$, e), 'unresolved');
  PERFORM test.login('alpha', 'senior');     -- neither preparer nor manager/partner
  PERFORM test.expect_error(format($q$UPDATE app.adjusting_entries SET status = 'rejected' WHERE engagement_id = %L$q$, e),
                            'can void');
  PERFORM test.login('alpha', 'manager');
  UPDATE app.adjusting_entries SET status = 'rejected' WHERE engagement_id = e;

  UPDATE app.engagements SET stage = 'completed' WHERE id = e;
  PERFORM test.expect_error(format($q$UPDATE app.engagements SET stage = 'reporting' WHERE id = %L$q$, e),
                            'illegal stage transition');
  PERFORM test.expect_error(format($q$UPDATE app.engagements SET stage = 'archived' WHERE id = %L$q$, e),
                            'only the engagement partner');
  PERFORM test.login('alpha', 'partner');
  UPDATE app.engagements SET stage = 'archived', archived_at = TIMESTAMPTZ '2020-01-01' WHERE id = e;
  ASSERT (SELECT archived_at FROM app.engagements WHERE id = e) > now() - interval '1 minute',
         'G3 archived_at must be server time';
END
$$;

-- G4  The archived file is closed to every write path.
DO $$
DECLARE t uuid := test.tenant('alpha'); e uuid := test.eng('alpha', 'ENG-A');
BEGIN
  PERFORM test.login('alpha', 'partner');
  PERFORM test.expect_error(format($q$UPDATE app.engagements SET report_date = '2026-03-20' WHERE id = %L$q$, e), 'archived');
  PERFORM test.expect_error(format($q$INSERT INTO app.workpapers (tenant_id, engagement_id, ref_code, title, phase)
                                      VALUES (%L, %L, 'Z-999', 'Late addition', 'reporting')$q$, t, e), 'archived');
  PERFORM test.expect_error(format($q$INSERT INTO app.adjusting_entries (tenant_id, engagement_id, entry_type, description, effective_date)
                                      VALUES (%L, %L, 'AJE', 'Back-dated entry', '2025-12-31')$q$, t, e), 'archived');
  PERFORM test.expect_error(format($q$UPDATE app.engagement_members SET role = 'manager'
                                      WHERE engagement_id = %L AND user_id = %L$q$, e, test.uid('alpha', 'senior')), 'archived');
  PERFORM test.login('alpha', 'client');
  PERFORM test.expect_error(format($q$INSERT INTO app.evidence_files (tenant_id, engagement_id, object_key, sha256, byte_size,
                                                                      original_filename, detected_mime, retain_until)
                                      VALUES (%L, %L, %L, ext.digest('x','sha256'), 1, 'late.pdf', 'application/pdf', '2030-01-01')$q$,
                                   t, e, format('tenants/%s/engagements/%s/late.pdf', t, e)), 'archived');
END
$$;

ROLLBACK;
