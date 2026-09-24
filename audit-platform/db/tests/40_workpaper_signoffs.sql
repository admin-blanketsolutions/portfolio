-- =============================================================================
-- Workpaper versions and the 3-tier sign-off (preparer -> reviewer -> partner).
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE audit_app;

CREATE TEMP TABLE ctx_ids AS SELECT NULL::uuid AS wp, NULL::uuid AS v1, NULL::bytea AS h1;
GRANT ALL ON ctx_ids TO PUBLIC;

DO $$
DECLARE v_wp uuid; v_v uuid; v_h bytea;
BEGIN
  PERFORM test.login('alpha', 'manager');
  INSERT INTO app.workpapers (tenant_id, engagement_id, ref_code, title, phase, status, current_version)
  VALUES (test.tenant('alpha'), test.eng('alpha', 'ENG-A'), 'A-100', 'Revenue cut-off testing', 'fieldwork',
          'approved', 42)                                   -- spoofed derived columns are ignored
  RETURNING id INTO v_wp;

  PERFORM test.login('alpha', 'junior');
  INSERT INTO app.workpaper_versions (tenant_id, workpaper_id, engagement_id, version_no, content, content_sha256,
                                      created_at)
  VALUES (test.tenant('alpha'), v_wp, test.eng('alpha', 'ENG-A'), 99,
          '{"procedure":"Vouch 25 sales either side of YE","conclusion":"No exceptions"}',
          ext.digest('forged', 'sha256'), TIMESTAMPTZ '2001-01-01')      -- forged hash & back-dated time
  RETURNING id, content_sha256 INTO v_v, v_h;
  UPDATE ctx_ids SET wp = v_wp, v1 = v_v, h1 = v_h;
END
$$;

-- S1  Derived & server-authoritative columns.
DO $$
DECLARE r record; wp_r record;
BEGIN
  SELECT * INTO r FROM app.workpaper_versions v WHERE v.id = (SELECT v1 FROM ctx_ids);
  ASSERT r.version_no = 1, 'S1 version_no must be assigned by the DB';
  ASSERT r.content_sha256 = ext.digest(convert_to(r.content::text, 'UTF8'), 'sha256'), 'S1 hash must be recomputed';
  ASSERT r.created_at > now() - interval '1 minute', 'S1 created_at must be server time, got ' || r.created_at;
  ASSERT r.created_by = test.uid('alpha', 'junior'), 'S1 created_by must be the ctx actor';
  SELECT * INTO wp_r FROM app.workpapers w WHERE w.id = (SELECT wp FROM ctx_ids);
  ASSERT wp_r.status = 'draft' AND wp_r.current_version = 1, 'S1 status/version must be derived';
END
$$;

-- S2  Preparer sign-off; impersonation is refused.
DO $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM ctx_ids;
  PERFORM test.login('alpha', 'junior');
  PERFORM test.expect_error(format(
    $q$INSERT INTO app.workpaper_signoffs (tenant_id, workpaper_id, engagement_id, version_id, level, signed_by,
                                           content_sha256)
       VALUES (%L, %L, %L, %L, 'preparer', %L, %L)$q$,
      test.tenant('alpha'), c.wp, test.eng('alpha', 'ENG-A'), c.v1, test.uid('alpha', 'senior'), c.h1),
    'on behalf');
  INSERT INTO app.workpaper_signoffs (tenant_id, workpaper_id, engagement_id, version_id, level, content_sha256)
  VALUES (test.tenant('alpha'), c.wp, test.eng('alpha', 'ENG-A'), c.v1, 'preparer', c.h1);
  ASSERT (SELECT status FROM app.workpapers WHERE id = c.wp) = 'prepared', 'S2 status should be prepared';

  -- S3  Segregation of duties: the preparer cannot also review.
  PERFORM test.expect_error(format(
    $q$INSERT INTO app.workpaper_signoffs (tenant_id, workpaper_id, engagement_id, version_id, level, content_sha256,
                                           step_up_assertion)
       VALUES (%L, %L, %L, %L, 'reviewer', %L, '{}')$q$,
      test.tenant('alpha'), c.wp, test.eng('alpha', 'ENG-A'), c.v1, c.h1),
    'segregation of duties');
END
$$;

-- S4  Order, step-up, hash binding, role eligibility.
DO $$
DECLARE c record; ins text;
BEGIN
  SELECT * INTO c FROM ctx_ids;
  ins := format($q$INSERT INTO app.workpaper_signoffs (tenant_id, workpaper_id, engagement_id, version_id, level,
                                                       content_sha256, step_up_assertion)
                   VALUES (%L, %L, %L, %L, %%L, %%L, %%s)$q$,
                test.tenant('alpha'), c.wp, test.eng('alpha', 'ENG-A'), c.v1);

  PERFORM test.login('alpha', 'senior');
  PERFORM test.expect_error(format(ins, 'partner', c.h1, $j$'{"webauthn":"ok"}'$j$), 'requires a reviewer');
  PERFORM test.expect_error(format(ins, 'reviewer', c.h1, 'NULL'), 'step-up');
  PERFORM test.expect_error(format(ins, 'reviewer', ext.digest('tampered', 'sha256'), $j$'{"webauthn":"ok"}'$j$),
                            'hash mismatch');
  EXECUTE format(ins, 'reviewer', c.h1, $j$'{"webauthn":"ok"}'$j$);
  ASSERT (SELECT status FROM app.workpapers WHERE id = c.wp) = 'reviewed', 'S4 status should be reviewed';

  PERFORM test.login('alpha', 'manager');
  PERFORM test.expect_error(format(ins, 'partner', c.h1, $j$'{"webauthn":"ok"}'$j$), 'only the engagement partner');

  -- S5  Derived status cannot be written directly.
  PERFORM test.expect_error(format($q$UPDATE app.workpapers SET status = 'approved' WHERE id = %L$q$, c.wp), 'derived');

  PERFORM test.login('alpha', 'partner');
  EXECUTE format(ins, 'partner', c.h1, $j$'{"webauthn":"ok"}'$j$);
  ASSERT (SELECT status FROM app.workpapers WHERE id = c.wp) = 'approved', 'S5 status should be approved';

  -- S6  Metadata frozen after sign-off; content cannot be deleted.
  PERFORM test.expect_error(format($q$UPDATE app.workpapers SET title = 'Rewritten' WHERE id = %L$q$, c.wp), 'frozen');
  PERFORM test.expect_error(format($q$DELETE FROM app.workpapers WHERE id = %L$q$, c.wp), 'cannot be deleted');
  -- The app role has no UPDATE/DELETE on versions or sign-offs at all.
  PERFORM test.expect_error($q$UPDATE app.workpaper_signoffs SET level = 'preparer'$q$, 'permission denied');
  PERFORM test.expect_error($q$DELETE FROM app.workpaper_versions$q$, 'permission denied');
END
$$;

-- S7  A new version invalidates sign-offs; stale-version signing is refused.
DO $$
DECLARE c record; v2 uuid; h2 bytea;
BEGIN
  SELECT * INTO c FROM ctx_ids;
  PERFORM test.login('alpha', 'manager');
  INSERT INTO app.workpaper_versions (tenant_id, workpaper_id, engagement_id, content, content_sha256)
  VALUES (test.tenant('alpha'), c.wp, test.eng('alpha', 'ENG-A'), '{"procedure":"Extended to 40 items"}',
          ext.digest('x', 'sha256'))
  RETURNING id, content_sha256 INTO v2, h2;
  ASSERT (SELECT status FROM app.workpapers WHERE id = c.wp) = 'draft', 'S7 new version must reset status';

  PERFORM test.login('alpha', 'senior');
  PERFORM test.expect_error(format(
    $q$INSERT INTO app.workpaper_signoffs (tenant_id, workpaper_id, engagement_id, version_id, level, content_sha256)
       VALUES (%L, %L, %L, %L, 'preparer', %L)$q$,
      test.tenant('alpha'), c.wp, test.eng('alpha', 'ENG-A'), c.v1, c.h1),
    'stale version');

  -- S8  Reviewer must not be junior to the preparer (manager prepared, senior reviews).
  PERFORM test.login('alpha', 'manager');
  INSERT INTO app.workpaper_signoffs (tenant_id, workpaper_id, engagement_id, version_id, level, content_sha256)
  VALUES (test.tenant('alpha'), c.wp, test.eng('alpha', 'ENG-A'), v2, 'preparer', h2);
  PERFORM test.login('alpha', 'senior');
  PERFORM test.expect_error(format(
    $q$INSERT INTO app.workpaper_signoffs (tenant_id, workpaper_id, engagement_id, version_id, level, content_sha256,
                                           step_up_assertion)
       VALUES (%L, %L, %L, %L, 'reviewer', %L, '{}')$q$,
      test.tenant('alpha'), c.wp, test.eng('alpha', 'ENG-A'), v2, h2),
    'not junior to the preparer');

  -- S9  A client contact can never sign (and cannot even see the workpaper).
  PERFORM test.login('alpha', 'client');
  PERFORM test.expect_error(format(
    $q$INSERT INTO app.workpaper_signoffs (tenant_id, workpaper_id, engagement_id, version_id, level, content_sha256)
       VALUES (%L, %L, %L, %L, 'preparer', %L)$q$,
      test.tenant('alpha'), c.wp, test.eng('alpha', 'ENG-A'), v2, h2),
    'row-level security|not found');
END
$$;

-- S10 Even a superuser-level session hits the append-only triggers.
RESET ROLE;
DO $$
BEGIN
  PERFORM test.expect_error('UPDATE app.workpaper_signoffs SET signed_at = now()', 'append-only');
  PERFORM test.expect_error('DELETE FROM app.workpaper_versions', 'append-only');
  PERFORM test.expect_error('TRUNCATE app.workpaper_signoffs', 'TRUNCATE .* not permitted|cannot truncate');
END
$$;

ROLLBACK;
