-- =============================================================================
-- Intra-tenant ethical walls & client-portal isolation.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE audit_app;

-- Seed some content on both alpha engagements.
DO $$
BEGIN
  PERFORM test.login('alpha', 'manager');
  INSERT INTO app.workpapers (tenant_id, engagement_id, ref_code, title, phase)
  VALUES (test.tenant('alpha'), test.eng('alpha', 'ENG-A'), 'C-100', 'Cash lead schedule', 'fieldwork');

  PERFORM test.login('alpha', 'partner');
  UPDATE app.engagements SET overall_materiality = 1000, performance_materiality = 750,
                             clearly_trivial_threshold = 50, stage = 'fieldwork'
   WHERE id = test.eng('alpha', 'ENG-WALL');
  INSERT INTO app.workpapers (tenant_id, engagement_id, ref_code, title, phase)
  VALUES (test.tenant('alpha'), test.eng('alpha', 'ENG-WALL'), 'X-001', 'Confidential: competitor', 'fieldwork');
END
$$;

-- W1  A staff member outside the team sees the engagement header, never its content.
DO $$
DECLARE n bigint;
BEGIN
  PERFORM test.login('alpha', 'junior');   -- member of ENG-A only
  SELECT count(*) INTO n FROM app.engagements WHERE code = 'ENG-WALL';
  ASSERT n = 1, 'W1 header should be visible to firm staff';
  SELECT count(*) INTO n FROM app.workpapers WHERE engagement_id = test.eng('alpha', 'ENG-WALL');
  ASSERT n = 0, 'W1 walled workpapers leaked to non-member';
  SELECT count(*) INTO n FROM app.workpapers;
  ASSERT n = 1, 'W1 member should see own engagement WP, got ' || n;
  -- Nor can they write into it.
  PERFORM test.expect_error(format(
    $q$INSERT INTO app.workpapers (tenant_id, engagement_id, ref_code, title, phase)
       VALUES (%L, %L, 'X-002', 'sneaky', 'fieldwork')$q$, test.tenant('alpha'), test.eng('alpha', 'ENG-WALL')),
    'row-level security');
  -- Nor rewrite the engagement header.
  PERFORM test.expect_error(format(
    $q$UPDATE app.engagements SET overall_materiality = 1 WHERE id = %L$q$, test.eng('alpha', 'ENG-WALL')),
    'manager/partner');
END
$$;

-- W2  Firm admins are not exempt from the wall on content…
DO $$
DECLARE n bigint;
BEGIN
  PERFORM test.login('alpha', 'admin');
  SELECT count(*) INTO n FROM app.workpapers;
  ASSERT n = 0, 'W2 firm admin should not read engagement content without membership';
  -- …and joining a team to peek is recorded in the tamper-evident log.
  INSERT INTO app.engagement_members (tenant_id, engagement_id, user_id, role)
  VALUES (test.tenant('alpha'), test.eng('alpha', 'ENG-WALL'), test.uid('alpha', 'admin'), 'manager');
  SELECT count(*) INTO n FROM app.workpapers WHERE engagement_id = test.eng('alpha', 'ENG-WALL');
  ASSERT n = 1, 'W2 admin should see content after joining';
  SELECT count(*) INTO n FROM audit.events
   WHERE table_name = 'app.engagement_members' AND op = 'INSERT'
     AND engagement_id = test.eng('alpha', 'ENG-WALL') AND actor_user_id = test.uid('alpha', 'admin');
  ASSERT n = 1, 'W2 self-staffing must be captured in audit.events';
END
$$;

-- W3  Removed members lose access immediately.
DO $$
DECLARE n bigint;
BEGIN
  PERFORM test.login('alpha', 'manager');
  UPDATE app.engagement_members SET removed_at = clock_timestamp()
   WHERE engagement_id = test.eng('alpha', 'ENG-A') AND user_id = test.uid('alpha', 'junior');
  PERFORM test.login('alpha', 'junior');
  SELECT count(*) INTO n FROM app.workpapers;
  ASSERT n = 0, 'W3 removed member still sees content';
END
$$;

-- W4  Client-portal contacts: own engagement header & client only; no internal content.
DO $$
DECLARE n bigint;
BEGIN
  PERFORM test.login('alpha', 'client');
  SELECT count(*) INTO n FROM app.engagements;
  ASSERT n = 1, 'W4 client should see exactly their engagement, got ' || n;
  SELECT count(*) INTO n FROM app.clients;
  ASSERT n = 1, 'W4 client should see exactly their company, got ' || n;
  SELECT count(*) INTO n FROM app.users;
  ASSERT n = 1, 'W4 client should see only themselves in the directory, got ' || n;
  SELECT count(*) INTO n FROM app.workpapers;
  ASSERT n = 0, 'W4 client must never see workpapers';
  SELECT count(*) INTO n FROM app.coa_accounts;
  ASSERT n = 0, 'W4 client must not see the firm COA';
  SELECT count(*) INTO n FROM app.engagement_members;
  ASSERT n = 1, 'W4 client sees only own membership row, got ' || n;
  SELECT count(*) INTO n FROM audit.events;
  ASSERT n = 0, 'W4 client must not read the audit log';

  -- PBC upload: allowed, and bound to the tenant/engagement storage prefix.
  INSERT INTO app.evidence_files (tenant_id, engagement_id, object_key, sha256, byte_size, original_filename,
                                  detected_mime, retain_until)
  VALUES (test.tenant('alpha'), test.eng('alpha', 'ENG-A'),
          format('tenants/%s/engagements/%s/pbc/bank-confirmation.pdf', test.tenant('alpha'), test.eng('alpha', 'ENG-A')),
          ext.digest('pdf-bytes', 'sha256'), 1024, 'bank-confirmation.pdf', 'application/pdf', DATE '2026-01-01');
  -- Path pointing at another tenant's prefix is rejected by a CHECK, whoever writes it.
  PERFORM test.expect_error(format(
    $q$INSERT INTO app.evidence_files (tenant_id, engagement_id, object_key, sha256, byte_size, original_filename,
                                       detected_mime, retain_until)
       VALUES (%L, %L, %L, ext.digest('x', 'sha256'), 1, 'x.pdf', 'application/pdf', '2026-01-01')$q$,
      test.tenant('alpha'), test.eng('alpha', 'ENG-A'),
      format('tenants/%s/engagements/%s/x.pdf', test.tenant('beta'), test.eng('alpha', 'ENG-A'))),
    'check constraint');
  -- Clients cannot staff engagements or create them.
  PERFORM test.expect_error(format(
    $q$INSERT INTO app.engagement_members (tenant_id, engagement_id, user_id, role)
       VALUES (%L, %L, %L, 'client_contact')$q$,
      test.tenant('alpha'), test.eng('alpha', 'ENG-WALL'), test.uid('alpha', 'client')),
    'row-level security|not authorised|engagement not found');
END
$$;

-- W5  Retention floor is enforced server-side on evidence (period end + retention years).
DO $$
DECLARE d date;
BEGIN
  PERFORM test.login('alpha', 'manager');
  SELECT retain_until INTO d FROM app.evidence_files LIMIT 1;
  ASSERT d = DATE '2035-12-31', 'W5 retain_until should be period_end + 10y, got ' || d;
  -- Only a service principal can record the malware verdict; nobody can edit the rest.
  PERFORM test.expect_error($q$UPDATE app.evidence_files SET scan_status = 'clean'$q$, 'immutable');
  PERFORM test.login('alpha', 'svc');
  UPDATE app.evidence_files SET scan_status = 'clean';
  PERFORM test.expect_error($q$UPDATE app.evidence_files SET original_filename = 'renamed.pdf'$q$, 'immutable');
  PERFORM test.expect_error($q$DELETE FROM app.evidence_files$q$, 'permission denied|not permitted');
END
$$;

ROLLBACK;
