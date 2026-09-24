-- =============================================================================
-- Tamper-evident audit chain: recording, verification, and three tamper
-- scenarios a privileged insider could attempt.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;

-- C1  The chain built by the fixtures verifies.
SET LOCAL ROLE audit_app;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.login('alpha', 'admin');
  SELECT * INTO r FROM audit.verify_chain(test.tenant('alpha'));
  ASSERT r.ok AND r.events_checked > 20, format('C1 chain should verify: %s', row_to_json(r));
  PERFORM test.expect_error(format(
    $q$INSERT INTO audit.events (tenant_id, seq, occurred_at, txid, db_session_user, table_name, op, prev_hash, row_hash)
       VALUES (%L, 999999, now(), 1, 'x', 'forged', 'INSERT', audit.genesis(), audit.genesis())$q$, test.tenant('alpha')),
    'permission denied');
END
$$;

-- C2  A DBA edit made WITHOUT an app context is still chained, and it
--     self-identifies (no actor, real session user).
RESET ROLE;
SELECT test.logout();
UPDATE app.clients SET legal_name = 'Renamed in psql' WHERE registration_number = 'REG-alpha';
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM audit.events
   WHERE tenant_id = test.tenant('alpha') AND table_name = 'app.clients' AND op = 'UPDATE'
   ORDER BY seq DESC LIMIT 1;
  ASSERT r.actor_user_id IS NULL AND r.db_session_user = session_user,
         'C2 out-of-band change must be recorded with NULL actor and the real session user';
  ASSERT r.new_row->>'legal_name' = 'Renamed in psql' AND r.old_row->>'legal_name' <> 'Renamed in psql',
         'C2 before/after images';
END
$$;

-- Anchor the current head (what the independent anchoring job does; in
-- production it also writes the signed document to S3 Object Lock).
SELECT test.tenant('alpha') AS alpha_id \gset
SET LOCAL ROLE audit_anchor;
INSERT INTO audit.anchors (tenant_id, seq, head_hash, signature, signing_key_ref, external_ref)
SELECT tenant_id, last_seq, last_hash, '\xdeadbeef', 'arn:aws:kms:me-central-1:222222222222:key/anchor',
       's3://evidence-anchors/' || tenant_id || '/' || last_seq || '.json'
  FROM audit.chain_heads WHERE tenant_id = :'alpha_id';
RESET ROLE;

-- C3  Editing one event (triggers disabled by a superuser) is detected.
SAVEPOINT t3;
ALTER TABLE audit.events DISABLE TRIGGER USER;
UPDATE audit.events SET new_row = jsonb_set(new_row, '{display_name}', '"Ghost"')
 WHERE tenant_id = test.tenant('alpha') AND seq = 3;
ALTER TABLE audit.events ENABLE TRIGGER USER;
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM audit.verify_chain(test.tenant('alpha'));
  ASSERT NOT r.ok AND r.first_bad_seq = 3 AND r.detail = 'event content altered', format('C3 %s', row_to_json(r));
END
$$;
ROLLBACK TO SAVEPOINT t3;

-- C4  Deleting the most recent events (tail truncation) is detected.
SAVEPOINT t4;
ALTER TABLE audit.events DISABLE TRIGGER USER;
DELETE FROM audit.events
 WHERE tenant_id = test.tenant('alpha')
   AND seq > (SELECT last_seq - 2 FROM audit.chain_heads WHERE tenant_id = test.tenant('alpha'));
ALTER TABLE audit.events ENABLE TRIGGER USER;
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM audit.verify_chain(test.tenant('alpha'));
  ASSERT NOT r.ok AND r.detail LIKE 'chain head mismatch%', format('C4 %s', row_to_json(r));
END
$$;
ROLLBACK TO SAVEPOINT t4;

-- C5  A full, internally consistent rewrite (edit + recompute every hash +
--     fix the head) passes the internal check but diverges from the anchor.
SAVEPOINT t5;
ALTER TABLE audit.events DISABLE TRIGGER USER;
DO $$
DECLARE e record; prev bytea := audit.genesis(); h bytea;
BEGIN
  UPDATE audit.events SET new_row = jsonb_set(new_row, '{display_name}', '"Ghost"')
   WHERE tenant_id = test.tenant('alpha') AND seq = 3;
  FOR e IN SELECT * FROM audit.events WHERE tenant_id = test.tenant('alpha') ORDER BY seq LOOP
    h := audit.event_hash(prev, e.tenant_id, e.seq, e.occurred_at, e.txid, e.actor_user_id, e.db_session_user,
                          e.table_name, e.op, e.row_id, e.old_row, e.new_row);
    UPDATE audit.events SET prev_hash = prev, row_hash = h WHERE tenant_id = e.tenant_id AND seq = e.seq;
    prev := h;
  END LOOP;
  UPDATE audit.chain_heads SET last_hash = prev WHERE tenant_id = test.tenant('alpha');
END
$$;
ALTER TABLE audit.events ENABLE TRIGGER USER;
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM audit.verify_chain(test.tenant('alpha'));
  ASSERT NOT r.ok AND r.detail = 'diverges from anchor', format('C5 %s', row_to_json(r));
END
$$;
ROLLBACK TO SAVEPOINT t5;

-- C6  Even the owner/superuser path cannot UPDATE/DELETE/TRUNCATE events while triggers are on.
DO $$
BEGIN
  PERFORM test.expect_error('UPDATE audit.events SET op = op', 'append-only');
  PERFORM test.expect_error('DELETE FROM audit.events', 'append-only');
  PERFORM test.expect_error('TRUNCATE audit.events', 'not permitted');
END
$$;
ROLLBACK;

-- C7  Verification rights, exercised through a real (non-superuser) login.
\connect - audit_app_it
BEGIN;
DO $$
BEGIN
  PERFORM test.login('alpha', 'junior');
  PERFORM test.expect_error(format('SELECT * FROM audit.verify_chain(%L)', test.tenant('alpha')), 'not authorised');
  PERFORM test.login('alpha', 'admin');
  PERFORM test.expect_error(format('SELECT * FROM audit.verify_chain(%L)', test.tenant('beta')), 'not authorised');
  PERFORM test.login('alpha', 'svc');
  ASSERT (SELECT ok FROM audit.verify_chain(test.tenant('alpha'))), 'C7 service principal may verify own tenant';
END
$$;
ROLLBACK;
