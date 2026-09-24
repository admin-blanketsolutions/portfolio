-- =============================================================================
-- V0006 — Tamper-evident audit chain
-- -----------------------------------------------------------------------------
-- Every INSERT/UPDATE/DELETE on an audited table appends an event to a
-- per-tenant hash chain:
--
--     row_hash(n) = SHA-256( row_hash(n-1) || canonical(event n) )
--
-- * Written by a SECURITY DEFINER trigger owned by audit_owner; audit_app has
--   SELECT only (under RLS) — the application cannot forge or skip events.
-- * Changes made WITHOUT a verified context (e.g. a DBA in psql) are still
--   chained, with actor_user_id = NULL and the real session_user: out-of-band
--   edits are self-incriminating.
-- * A superuser CAN disable triggers or rewrite the chain end-to-end. That is
--   caught by ANCHORING: an independent job (role audit_anchor, separate AWS
--   account) periodically signs {tenant, seq, head_hash} with an asymmetric
--   KMS key and writes it to an S3 bucket in Object Lock COMPLIANCE mode. Any
--   rewrite then disagrees with an anchor nobody in the primary account can
--   delete. audit.verify_chain() + the anchors table make this checkable.
--
-- Trade-off: the chain head row is locked until commit, which serialises
-- audited writes within ONE tenant (not across tenants). Audited tables are
-- low-volume by design (TB lines are covered by a digest on trial_balances).
-- =============================================================================
SET ROLE audit_owner;

CREATE TABLE audit.chain_heads (
  tenant_id  uuid   PRIMARY KEY REFERENCES platform.tenants (id),
  last_seq   bigint NOT NULL CHECK (last_seq >= 0),
  last_hash  bytea  NOT NULL CHECK (octet_length(last_hash) = 32)
);

CREATE TABLE audit.events (
  tenant_id        uuid        NOT NULL REFERENCES platform.tenants (id),
  seq              bigint      NOT NULL CHECK (seq > 0),
  occurred_at      timestamptz NOT NULL,
  txid             bigint      NOT NULL,
  actor_user_id    uuid,                   -- NULL => change made outside a verified app context
  db_session_user  name        NOT NULL,
  table_name       text        NOT NULL,
  op               text        NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  row_id           uuid,
  engagement_id    uuid,
  old_row          jsonb,
  new_row          jsonb,
  prev_hash        bytea       NOT NULL CHECK (octet_length(prev_hash) = 32),
  row_hash         bytea       NOT NULL CHECK (octet_length(row_hash) = 32),
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX events_engagement_ix ON audit.events (tenant_id, engagement_id, occurred_at);
CREATE INDEX events_row_ix        ON audit.events (tenant_id, table_name, row_id);

CREATE TABLE audit.anchors (
  tenant_id        uuid        NOT NULL REFERENCES platform.tenants (id),
  seq              bigint      NOT NULL,
  head_hash        bytea       NOT NULL CHECK (octet_length(head_hash) = 32),
  anchored_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  signature        bytea       NOT NULL,   -- KMS ECC_NIST_P256 signature over the JCS anchor document
  signing_key_ref  text        NOT NULL,   -- KMS key ARN in the separate "evidence" account
  external_ref     text        NOT NULL,   -- s3://…?versionId=… (Object Lock COMPLIANCE) and/or RFC 3161 token id
  PRIMARY KEY (tenant_id, seq)
);

CREATE FUNCTION audit.genesis() RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$ SELECT decode(repeat('00', 32), 'hex') $$;

-- Canonical, unambiguous encoding: a JSON array (no delimiter ambiguity);
-- timestamps pre-rendered in UTC so DateStyle/TimeZone cannot change the bytes.
CREATE FUNCTION audit.event_hash(
  p_prev bytea, p_tenant uuid, p_seq bigint, p_occurred timestamptz, p_txid bigint,
  p_actor uuid, p_session_user name, p_table text, p_op text, p_row_id uuid,
  p_old jsonb, p_new jsonb) RETURNS bytea
LANGUAGE sql STABLE
SET search_path = pg_catalog, ext, pg_temp
AS $$
  SELECT ext.digest(
    p_prev || convert_to(jsonb_build_array(
      p_tenant, p_seq,
      to_char(p_occurred AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      p_txid, p_actor, p_session_user::text, p_table, p_op, p_row_id, p_old, p_new)::text, 'UTF8'),
    'sha256')
$$;

-- TG_ARGV: names of columns to redact from the stored images (e.g. large
-- content bodies that are already bound by a content hash column).
CREATE FUNCTION audit.tg_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, ext, pg_temp
AS $$
DECLARE
  o      jsonb;
  n      jsonb;
  r      jsonb;
  t      uuid;
  rid    uuid;
  eng    uuid;
  s      bigint;
  prev   bytea;
  h      bytea;
  ts     timestamptz := clock_timestamp();
  xid    bigint := pg_current_xact_id()::text::bigint;
  actor  uuid;
  col    text;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
  FOREACH col IN ARRAY coalesce(TG_ARGV, ARRAY[]::text[]) LOOP
    o := o - col; n := n - col;
  END LOOP;
  r   := coalesce(n, o);
  t   := (r->>'tenant_id')::uuid;
  rid := (r->>'id')::uuid;
  eng := CASE WHEN TG_TABLE_NAME = 'engagements' THEN rid ELSE (r->>'engagement_id')::uuid END;
  actor := app.current_user_id();

  INSERT INTO audit.chain_heads (tenant_id, last_seq, last_hash)
  VALUES (t, 0, audit.genesis()) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT last_seq, last_hash INTO s, prev FROM audit.chain_heads WHERE tenant_id = t FOR UPDATE;
  s := s + 1;
  h := audit.event_hash(prev, t, s, ts, xid, actor, session_user, TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
                        TG_OP, rid, o, n);

  INSERT INTO audit.events (tenant_id, seq, occurred_at, txid, actor_user_id, db_session_user, table_name,
                            op, row_id, engagement_id, old_row, new_row, prev_hash, row_hash)
  VALUES (t, s, ts, xid, actor, session_user, TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
          TG_OP, rid, eng, o, n, prev, h);
  UPDATE audit.chain_heads SET last_seq = s, last_hash = h WHERE tenant_id = t;
  RETURN NULL;
END
$$;

-- Recompute the chain. Detects: edited events, re-ordered/deleted events,
-- broken links, and tail truncation (head mismatch). Rewrites of the WHOLE
-- chain are detected by comparing with audit.anchors / the external copies.
CREATE FUNCTION audit.verify_chain(p_tenant uuid)
RETURNS TABLE (ok boolean, events_checked bigint, first_bad_seq bigint, head_hash text, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, ext, pg_temp
AS $$
DECLARE
  prev bytea := audit.genesis();
  e    record;
  n    bigint := 0;
  hd   record;
  anc  record;
BEGIN
  IF NOT (pg_has_role(session_user, 'audit_anchor', 'MEMBER')
          OR (p_tenant = app.current_tenant_id() AND (app.ctx_is_firm_admin() OR app.ctx_is_service()))) THEN
    RAISE EXCEPTION 'not authorised to verify this chain' USING ERRCODE = '42501';
  END IF;

  FOR e IN SELECT * FROM audit.events WHERE tenant_id = p_tenant ORDER BY seq LOOP
    IF e.seq <> n + 1 THEN
      RETURN QUERY SELECT false, n, n + 1, encode(prev, 'hex'), 'sequence gap'; RETURN;
    END IF;
    IF e.prev_hash <> prev THEN
      RETURN QUERY SELECT false, n, e.seq, encode(prev, 'hex'), 'broken link'; RETURN;
    END IF;
    IF e.row_hash <> audit.event_hash(e.prev_hash, e.tenant_id, e.seq, e.occurred_at, e.txid, e.actor_user_id,
                                      e.db_session_user, e.table_name, e.op, e.row_id, e.old_row, e.new_row) THEN
      RETURN QUERY SELECT false, n, e.seq, encode(prev, 'hex'), 'event content altered'; RETURN;
    END IF;
    prev := e.row_hash;
    n := n + 1;
  END LOOP;

  SELECT * INTO hd FROM audit.chain_heads WHERE tenant_id = p_tenant;
  IF FOUND AND (hd.last_seq <> n OR hd.last_hash <> prev) THEN
    RETURN QUERY SELECT false, n, n + 1, encode(prev, 'hex'), 'chain head mismatch (truncation?)'; RETURN;
  END IF;

  -- Every anchor must still be on the chain.
  FOR anc IN SELECT * FROM audit.anchors WHERE tenant_id = p_tenant ORDER BY seq LOOP
    IF NOT EXISTS (SELECT 1 FROM audit.events ev
                    WHERE ev.tenant_id = p_tenant AND ev.seq = anc.seq AND ev.row_hash = anc.head_hash) THEN
      RETURN QUERY SELECT false, n, anc.seq, encode(prev, 'hex'), 'diverges from anchor'; RETURN;
    END IF;
  END LOOP;

  RETURN QUERY SELECT true, n, NULL::bigint, encode(prev, 'hex'), 'ok';
END
$$;

-- Append-only enforcement on the audit tables themselves.
CREATE TRIGGER t90_append_only BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION app.tg_append_only();
CREATE TRIGGER t99_no_truncate BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION app.tg_no_truncate();
CREATE TRIGGER t90_append_only BEFORE UPDATE OR DELETE ON audit.anchors
  FOR EACH ROW EXECUTE FUNCTION app.tg_append_only();
CREATE TRIGGER t99_no_truncate BEFORE TRUNCATE ON audit.anchors
  FOR EACH STATEMENT EXECUTE FUNCTION app.tg_no_truncate();

-- Read access for the app: tenant-bound, and engagement events only for the
-- engagement team (firm admins and service principals see all of the tenant).
-- Not FORCEd: the owner-run trigger must be able to append even when a DBA
-- works without a context, so that such changes are recorded, not blocked.
ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit.events FOR SELECT
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND NOT (SELECT app.ctx_is_client())
         AND ( (SELECT app.ctx_is_firm_admin()) OR (SELECT app.ctx_is_service())
               OR engagement_id IN (SELECT m.engagement_id FROM app.engagement_members m
                                     WHERE m.user_id = (SELECT app.current_user_id()) AND m.removed_at IS NULL)));

-- Attach to every audited table. tb_lines is covered by trial_balances.lines_sha256.
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.users              FOR EACH ROW EXECUTE FUNCTION audit.tg_record();
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.clients            FOR EACH ROW EXECUTE FUNCTION audit.tg_record();
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.coa_accounts       FOR EACH ROW EXECUTE FUNCTION audit.tg_record();
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.engagements        FOR EACH ROW EXECUTE FUNCTION audit.tg_record();
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.engagement_members FOR EACH ROW EXECUTE FUNCTION audit.tg_record();
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.trial_balances     FOR EACH ROW EXECUTE FUNCTION audit.tg_record();
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.account_mappings   FOR EACH ROW EXECUTE FUNCTION audit.tg_record();
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.workpapers         FOR EACH ROW EXECUTE FUNCTION audit.tg_record();
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.workpaper_versions FOR EACH ROW EXECUTE FUNCTION audit.tg_record('content');
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.workpaper_signoffs FOR EACH ROW EXECUTE FUNCTION audit.tg_record();
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.evidence_files     FOR EACH ROW EXECUTE FUNCTION audit.tg_record();
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.adjusting_entries  FOR EACH ROW EXECUTE FUNCTION audit.tg_record();
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.adjusting_entry_lines FOR EACH ROW EXECUTE FUNCTION audit.tg_record();
