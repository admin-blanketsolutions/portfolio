-- =============================================================================
-- V0005 — Integrity, state machines and immutability
-- -----------------------------------------------------------------------------
-- These triggers are the database's last line of defence: they hold even if an
-- API bug, a compromised service or a hand-written SQL session tries to
-- bypass the business rules. They do NOT stop a superuser who disables
-- triggers; that threat is covered by detection (V0006 hash chain + external
-- anchoring + pgaudit shipped to a separate account). See docs/01.
--
-- Conventions
--   * pg_trigger_depth() = 1  => the statement came from a client session.
--     Derived columns (workpaper status, TB supersession, AJE numbering) may
--     only change at depth > 1, i.e. from inside another trigger.
--   * Every time-of-record column is overwritten with clock_timestamp().
--   * Every "who" column is overwritten with the verified ctx actor.
--   * Rows are locked (FOR UPDATE / FOR SHARE) where a concurrent writer
--     could otherwise slip past a validation (posting races, stale sign-offs).
--   * Three-valued logic: a non-member's role is NULL, and `NULL IN (...)` is
--     NULL, so `IF NOT (x OR role IN (...))` silently PASSES. Every role check
--     is written NULL-safe (coalesce / IS NULL OR ...). The test-suite covers
--     non-members and service principals for each guarded transition.
-- =============================================================================
SET ROLE audit_owner;

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.role_rank(r app.engagement_role) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE r
    WHEN 'associate' THEN 1 WHEN 'senior' THEN 2 WHEN 'manager' THEN 3
    WHEN 'engagement_partner' THEN 4 ELSE 0 END
$$;

-- Active engagement role of the current actor (NULL if not an active member).
CREATE FUNCTION app.actor_engagement_role(p_tenant uuid, p_engagement uuid) RETURNS app.engagement_role
LANGUAGE sql STABLE AS $$
  SELECT m.role FROM app.engagement_members m
   WHERE m.tenant_id = p_tenant AND m.engagement_id = p_engagement
     AND m.user_id = app.current_user_id() AND m.removed_at IS NULL
$$;

CREATE FUNCTION app.assert_engagement_open(p_tenant uuid, p_engagement uuid) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE s app.engagement_stage;
BEGIN
  SELECT stage INTO s FROM app.engagements WHERE tenant_id = p_tenant AND id = p_engagement;
  IF s IS NULL THEN
    RAISE EXCEPTION 'engagement not found' USING ERRCODE = '42501';
  ELSIF s = 'archived' THEN
    RAISE EXCEPTION 'engagement % is archived; the file is closed (ISA 230.14-16)', p_engagement
      USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE FUNCTION app.tg_engagement_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
BEGIN
  PERFORM app.assert_engagement_open((r->>'tenant_id')::uuid, (r->>'engagement_id')::uuid);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

-- Server-authoritative created_at / created_by / updated_at.
-- TG_ARGV[0] = 'no_actor' for tables without created_by.
CREATE FUNCTION app.tg_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  has_actor boolean := coalesce(TG_ARGV[0], '') <> 'no_actor';
  patch     jsonb;
  cur       jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'INSERT' THEN
    patch := jsonb_build_object('created_at', clock_timestamp());
    IF has_actor THEN
      patch := patch || jsonb_build_object('created_by', app.require_actor());
    END IF;
  ELSE
    patch := jsonb_build_object('created_at', to_jsonb(OLD)->'created_at');
    IF has_actor THEN
      patch := patch || jsonb_build_object('created_by', to_jsonb(OLD)->'created_by');
    END IF;
  END IF;
  IF cur ? 'updated_at' THEN
    patch := patch || jsonb_build_object('updated_at', clock_timestamp());
  END IF;
  NEW := jsonb_populate_record(NEW, patch);
  RETURN NEW;
END
$$;

CREATE FUNCTION app.tg_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only (% rejected)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END
$$;

CREATE FUNCTION app.tg_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DELETE on %.% is not permitted; records are retained', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

-- TRUNCATE does not fire row triggers: a classic hole in "append-only" designs.
CREATE FUNCTION app.tg_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE on %.% is not permitted', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.tg_users_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.tenant_id, NEW.idp_subject, NEW.user_kind)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.idp_subject, OLD.user_kind) THEN
    RAISE EXCEPTION 'user identity columns are immutable' USING ERRCODE = '55000';
  END IF;
  IF app.current_user_id() IS NOT NULL AND NEW.id = app.current_user_id()
     AND TG_OP = 'UPDATE' AND NEW.is_firm_admin IS DISTINCT FROM OLD.is_firm_admin THEN
    RAISE EXCEPTION 'users cannot change their own admin flag' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- Engagements: stage machine & gates
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.stage_ord(s app.engagement_stage) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT array_position(ARRAY['planning','fieldwork','review','reporting','completed','archived']::app.engagement_stage[], s)
$$;

CREATE FUNCTION app.tg_engagements_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE rank app.professional_rank; adm boolean;
BEGIN
  SELECT u.professional_rank, u.is_firm_admin INTO rank, adm
    FROM app.users u WHERE u.tenant_id = NEW.tenant_id AND u.id = app.require_actor();
  IF NOT (coalesce(adm, false) OR coalesce(rank IN ('manager', 'director', 'partner'), false)) THEN
    RAISE EXCEPTION 'only managers, partners or firm admins create engagements' USING ERRCODE = '42501';
  END IF;
  NEW.stage := 'planning';
  NEW.archived_at := NULL;
  NEW.aje_seq := 0;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.tg_engagements_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  role  app.engagement_role;
  delta int;
  n     bigint;
BEGIN
  IF OLD.stage = 'archived' THEN
    RAISE EXCEPTION 'engagement % is archived; the file is closed (ISA 230.14-16)', OLD.id USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.client_id, NEW.code, NEW.reporting_currency)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.client_id, OLD.code, OLD.reporting_currency) THEN
    RAISE EXCEPTION 'engagement identity columns are immutable' USING ERRCODE = '55000';
  END IF;

  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;           -- internal bookkeeping (aje_seq) from other triggers
  END IF;

  IF NEW.aje_seq IS DISTINCT FROM OLD.aje_seq THEN
    RAISE EXCEPTION 'aje_seq is system-managed' USING ERRCODE = '55000';
  END IF;

  role := app.actor_engagement_role(NEW.tenant_id, NEW.id);
  IF NOT (app.ctx_is_firm_admin() OR app.ctx_is_service()
          OR coalesce(role IN ('manager', 'engagement_partner'), false)) THEN
    RAISE EXCEPTION 'only the engagement manager/partner may change the engagement' USING ERRCODE = '42501';
  END IF;

  IF OLD.stage <> 'planning' AND (NEW.period_start, NEW.period_end) IS DISTINCT FROM (OLD.period_start, OLD.period_end) THEN
    RAISE EXCEPTION 'the audit period is frozen once planning is complete' USING ERRCODE = '55000';
  END IF;

  IF NEW.stage = OLD.stage THEN
    NEW.archived_at := OLD.archived_at;
    RETURN NEW;
  END IF;

  -- Stage transitions: one step forward, or one step back from review/reporting.
  delta := app.stage_ord(NEW.stage) - app.stage_ord(OLD.stage);
  IF NOT (delta = 1 OR (delta = -1 AND OLD.stage IN ('review', 'reporting'))) THEN
    RAISE EXCEPTION 'illegal stage transition % -> %', OLD.stage, NEW.stage USING ERRCODE = '55000';
  END IF;

  IF OLD.stage = 'planning' AND NEW.stage = 'fieldwork' THEN
    IF NEW.overall_materiality IS NULL OR NEW.performance_materiality IS NULL
       OR NEW.clearly_trivial_threshold IS NULL THEN
      RAISE EXCEPTION 'materiality must be set before fieldwork (ISA 320)' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app.engagement_members m
                    WHERE m.tenant_id = NEW.tenant_id AND m.engagement_id = NEW.id
                      AND m.role = 'engagement_partner' AND m.removed_at IS NULL) THEN
      RAISE EXCEPTION 'an engagement partner must be assigned (ISA 220)' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.stage = 'completed' THEN
    IF NEW.report_date IS NULL THEN
      RAISE EXCEPTION 'report_date is required to complete the engagement' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app.trial_balances t
                    WHERE t.tenant_id = NEW.tenant_id AND t.engagement_id = NEW.id
                      AND t.tb_kind = 'current_unadjusted' AND t.status = 'locked') THEN
      RAISE EXCEPTION 'no locked trial balance' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO n FROM app.workpapers w
     WHERE w.tenant_id = NEW.tenant_id AND w.engagement_id = NEW.id
       AND (w.status <> 'approved' OR w.current_version = 0);
    IF n > 0 THEN
      RAISE EXCEPTION '% workpaper(s) lack partner approval on their current version', n USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO n FROM app.adjusting_entries a
     WHERE a.tenant_id = NEW.tenant_id AND a.engagement_id = NEW.id
       AND (a.status IN ('draft', 'proposed')
            OR (a.status = 'approved' AND a.entry_type <> 'PAJE'));
    IF n > 0 THEN
      RAISE EXCEPTION '% adjusting entr(y/ies) are unresolved', n USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.stage = 'archived' THEN
    IF role IS DISTINCT FROM 'engagement_partner' THEN
      RAISE EXCEPTION 'only the engagement partner may archive the file' USING ERRCODE = '42501';
    END IF;
    NEW.archived_at := clock_timestamp();
  ELSE
    NEW.archived_at := NULL;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- Engagement members
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.tg_members_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  kind      app.user_kind;
  role      app.engagement_role;
  creator   uuid;
  has_any   boolean;
BEGIN
  PERFORM app.assert_engagement_open(NEW.tenant_id, NEW.engagement_id);

  SELECT u.user_kind INTO kind FROM app.users u WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.user_id;
  IF kind IS NULL OR kind = 'service' OR (kind = 'client_contact') <> (NEW.role = 'client_contact') THEN
    RAISE EXCEPTION 'member role % is inconsistent with user kind %', NEW.role, kind USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.engagement_id, NEW.user_id) IS DISTINCT FROM (OLD.engagement_id, OLD.user_id) THEN
    RAISE EXCEPTION 'membership keys are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'removed memberships are historical records' USING ERRCODE = '55000';
  END IF;

  -- Who may staff an engagement: firm admin, the active manager/partner, or the
  -- engagement's creator while the team is still empty (bootstrap).
  role := app.actor_engagement_role(NEW.tenant_id, NEW.engagement_id);
  IF NOT (app.ctx_is_firm_admin() OR coalesce(role IN ('manager', 'engagement_partner'), false)) THEN
    SELECT e.created_by INTO creator FROM app.engagements e
     WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.engagement_id;
    SELECT EXISTS (SELECT 1 FROM app.engagement_members m
                    WHERE m.tenant_id = NEW.tenant_id AND m.engagement_id = NEW.engagement_id)
      INTO has_any;
    IF NOT (creator = app.current_user_id() AND NOT has_any) THEN
      RAISE EXCEPTION 'not authorised to change the engagement team' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- Trial balances & lines
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.tb_lines_digest(p_tenant uuid, p_tb uuid) RETURNS bytea
LANGUAGE sql STABLE AS $$
  SELECT ext.digest(convert_to(coalesce(string_agg(
           jsonb_build_array(l.line_no, l.client_account_code, l.client_account_name,
                             l.opening_balance, l.period_debit, l.period_credit,
                             l.closing_balance, l.source_had_formula)::text,
           E'\n' ORDER BY l.line_no), ''), 'UTF8'), 'sha256')
    FROM app.tb_lines l
   WHERE l.tenant_id = p_tenant AND l.trial_balance_id = p_tb
$$;

CREATE FUNCTION app.tg_trial_balances_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cnt   bigint; dr numeric; cr numeric; net numeric; unmapped bigint;
  role  app.engagement_role;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'importing' THEN
      RAISE EXCEPTION 'a trial balance starts in status importing' USING ERRCODE = '23514';
    END IF;
    NEW.locked_by := NULL; NEW.locked_at := NULL; NEW.lines_sha256 := NULL;
    RETURN NEW;
  END IF;

  IF NEW.lines_sha256 IS DISTINCT FROM OLD.lines_sha256
     AND NOT (OLD.status = 'importing' AND NEW.status = 'imported') THEN
    RAISE EXCEPTION 'lines digest is system-managed' USING ERRCODE = '55000';
  END IF;

  IF (NEW.engagement_id, NEW.tb_kind, NEW.version, NEW.as_of_date, NEW.currency, NEW.source_object_key,
      NEW.source_sha256, NEW.source_filename, NEW.parser_version, NEW.ctl_line_count,
      NEW.ctl_sum_debit, NEW.ctl_sum_credit)
     IS DISTINCT FROM
     (OLD.engagement_id, OLD.tb_kind, OLD.version, OLD.as_of_date, OLD.currency, OLD.source_object_key,
      OLD.source_sha256, OLD.source_filename, OLD.parser_version, OLD.ctl_line_count,
      OLD.ctl_sum_debit, OLD.ctl_sum_credit) THEN
    RAISE EXCEPTION 'trial balance provenance is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.status = OLD.status THEN
    IF (NEW.locked_by, NEW.locked_at) IS DISTINCT FROM (OLD.locked_by, OLD.locked_at) THEN
      RAISE EXCEPTION 'lock metadata is system-managed' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'importing' AND NEW.status = 'imported' THEN
    SELECT count(*),
           coalesce(sum(closing_balance) FILTER (WHERE closing_balance > 0), 0),
           coalesce(-sum(closing_balance) FILTER (WHERE closing_balance < 0), 0)
      INTO cnt, dr, cr
      FROM app.tb_lines WHERE tenant_id = NEW.tenant_id AND trial_balance_id = NEW.id;
    IF cnt <> NEW.ctl_line_count OR dr <> NEW.ctl_sum_debit OR cr <> NEW.ctl_sum_credit THEN
      RAISE EXCEPTION 'import does not reconcile to parser control totals (lines %/%, Dr %/%, Cr %/%)',
        cnt, NEW.ctl_line_count, dr, NEW.ctl_sum_debit, cr, NEW.ctl_sum_credit USING ERRCODE = '23514';
    END IF;
    NEW.lines_sha256 := app.tb_lines_digest(NEW.tenant_id, NEW.id);

  ELSIF OLD.status = 'imported' AND NEW.status = 'locked' THEN
    role := app.actor_engagement_role(NEW.tenant_id, NEW.engagement_id);
    IF app.role_rank(role) < 2 THEN
      RAISE EXCEPTION 'locking a trial balance requires senior or above' USING ERRCODE = '42501';
    END IF;
    IF app.tb_lines_digest(NEW.tenant_id, NEW.id) IS DISTINCT FROM OLD.lines_sha256 THEN
      RAISE EXCEPTION 'trial balance lines were altered after import (digest mismatch)' USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(sum(closing_balance), 0) INTO net
      FROM app.tb_lines WHERE tenant_id = NEW.tenant_id AND trial_balance_id = NEW.id;
    IF net <> 0 THEN
      RAISE EXCEPTION 'trial balance does not balance (net %); book differences to an explicit suspense line', net
        USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO unmapped FROM app.tb_lines l
     WHERE l.tenant_id = NEW.tenant_id AND l.trial_balance_id = NEW.id
       AND NOT EXISTS (SELECT 1 FROM app.account_mappings m
                        WHERE m.tenant_id = l.tenant_id AND m.tb_line_id = l.id AND m.status = 'accepted');
    IF unmapped > 0 THEN
      RAISE EXCEPTION '% line(s) have no human-accepted mapping', unmapped USING ERRCODE = '23514';
    END IF;
    -- Supersede the previously locked version (runs this trigger at depth 2).
    UPDATE app.trial_balances SET status = 'superseded'
     WHERE tenant_id = NEW.tenant_id AND engagement_id = NEW.engagement_id
       AND tb_kind = NEW.tb_kind AND status = 'locked' AND id <> NEW.id;
    NEW.locked_by := app.require_actor();
    NEW.locked_at := clock_timestamp();

  ELSIF OLD.status = 'locked' AND NEW.status = 'superseded' AND pg_trigger_depth() > 1 THEN
    NULL;  -- only via a newer lock
  ELSIF OLD.status IN ('importing', 'imported') AND NEW.status = 'superseded' THEN
    NULL;  -- abandoned import
  ELSE
    RAISE EXCEPTION 'illegal trial balance transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.tg_tb_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END); s app.tb_status;
BEGIN
  SELECT status INTO s FROM app.trial_balances
   WHERE tenant_id = (r->>'tenant_id')::uuid AND id = (r->>'trial_balance_id')::uuid
   FOR SHARE;
  IF s IS DISTINCT FROM 'importing' THEN
    RAISE EXCEPTION 'trial balance lines are frozen once the import is closed' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

-- ---------------------------------------------------------------------------
-- Account mappings: AI may suggest; only a human staff member may decide.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.tg_mappings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s    app.tb_status;
  kind app.user_kind;
BEGIN
  SELECT status INTO s FROM app.trial_balances
   WHERE tenant_id = NEW.tenant_id AND id = NEW.trial_balance_id FOR SHARE;
  IF s IS DISTINCT FROM 'imported' THEN
    RAISE EXCEPTION 'mappings can only change while the trial balance is imported and unlocked' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW.tb_line_id, NEW.trial_balance_id, NEW.coa_account_id, NEW.source, NEW.confidence,
        NEW.model_ref, NEW.rationale)
       IS DISTINCT FROM
       (OLD.tb_line_id, OLD.trial_balance_id, OLD.coa_account_id, OLD.source, OLD.confidence,
        OLD.model_ref, OLD.rationale) THEN
      RAISE EXCEPTION 'a mapping suggestion is immutable; create a new one' USING ERRCODE = '55000';
    END IF;
    IF OLD.status IN ('rejected', 'superseded') THEN
      RAISE EXCEPTION 'decided mappings are historical records' USING ERRCODE = '55000';
    END IF;
    IF NOT ((OLD.status = 'suggested' AND NEW.status IN ('accepted', 'rejected', 'superseded'))
            OR (OLD.status = 'accepted' AND NEW.status = 'superseded')) THEN
      RAISE EXCEPTION 'illegal mapping transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.status NOT IN ('suggested', 'accepted') OR (NEW.status = 'accepted' AND NEW.source <> 'manual') THEN
    RAISE EXCEPTION 'new machine mappings must start as suggested' USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('accepted', 'rejected') AND (TG_OP = 'INSERT' OR OLD.status = 'suggested') THEN
    SELECT u.user_kind INTO kind FROM app.users u
     WHERE u.tenant_id = NEW.tenant_id AND u.id = app.require_actor();
    IF app.ctx_is_service() OR kind IS DISTINCT FROM 'staff' THEN
      RAISE EXCEPTION 'mapping decisions require a human staff member (AI output is advisory only)'
        USING ERRCODE = '42501';
    END IF;
    NEW.decided_by := app.current_user_id();
    NEW.decided_at := clock_timestamp();
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.decided_by := OLD.decided_by;
    NEW.decided_at := OLD.decided_at;
  ELSE
    NEW.decided_by := NULL;
    NEW.decided_at := NULL;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- Workpapers, versions, sign-offs
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.tg_workpapers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'draft';
    NEW.current_version := 0;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.current_version > 0 THEN
      RAISE EXCEPTION 'workpapers with content cannot be deleted (ISA 230)' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.engagement_id, NEW.ref_code) IS DISTINCT FROM (OLD.id, OLD.engagement_id, OLD.ref_code) THEN
    RAISE EXCEPTION 'workpaper identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF pg_trigger_depth() = 1 THEN
    IF (NEW.status, NEW.current_version) IS DISTINCT FROM (OLD.status, OLD.current_version) THEN
      RAISE EXCEPTION 'workpaper status/version are derived from versions and sign-offs' USING ERRCODE = '55000';
    END IF;
    -- coa_path compared as text: ltree operators live in schema ext.
    IF OLD.status <> 'draft'
       AND (NEW.title, NEW.title_ar, NEW.phase, NEW.coa_path::text)
         IS DISTINCT FROM (OLD.title, OLD.title_ar, OLD.phase, OLD.coa_path::text) THEN
      RAISE EXCEPTION 'workpaper metadata is frozen once signed; add a new version' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.tg_wp_versions_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE cur int;
BEGIN
  SELECT current_version INTO cur FROM app.workpapers
   WHERE tenant_id = NEW.tenant_id AND id = NEW.workpaper_id FOR UPDATE;
  NEW.version_no     := cur + 1;
  NEW.content_sha256 := ext.digest(convert_to(NEW.content::text, 'UTF8'), 'sha256');
  -- A new version invalidates all sign-offs on the previous one.
  UPDATE app.workpapers SET current_version = NEW.version_no, status = 'draft'
   WHERE tenant_id = NEW.tenant_id AND id = NEW.workpaper_id;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.tg_signoffs_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor    uuid := app.require_actor();
  wp_cur   int;
  v_no     int;
  v_hash   bytea;
  role     app.engagement_role;
  prep_role app.engagement_role;
BEGIN
  IF NEW.signed_by IS NOT NULL AND NEW.signed_by <> actor THEN
    RAISE EXCEPTION 'cannot sign on behalf of another user' USING ERRCODE = '42501';
  END IF;
  NEW.signed_by := actor;
  NEW.signed_at := clock_timestamp();

  SELECT current_version INTO wp_cur FROM app.workpapers
   WHERE tenant_id = NEW.tenant_id AND id = NEW.workpaper_id FOR UPDATE;
  SELECT version_no, content_sha256 INTO v_no, v_hash FROM app.workpaper_versions
   WHERE tenant_id = NEW.tenant_id AND id = NEW.version_id;
  IF wp_cur IS NULL OR v_no IS NULL THEN
    RAISE EXCEPTION 'workpaper or version not found' USING ERRCODE = '42501';
  END IF;
  IF v_no IS DISTINCT FROM wp_cur THEN
    RAISE EXCEPTION 'stale version: v% is not the current version (v%)', v_no, wp_cur USING ERRCODE = '40001';
  END IF;
  IF NEW.content_sha256 IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'content hash mismatch: the signer did not see this content' USING ERRCODE = '23514';
  END IF;

  role := app.actor_engagement_role(NEW.tenant_id, NEW.engagement_id);
  IF role IS NULL OR role = 'client_contact' THEN
    RAISE EXCEPTION 'signer is not an active engagement team member' USING ERRCODE = '42501';
  END IF;
  NEW.signer_role := role;

  IF EXISTS (SELECT 1 FROM app.workpaper_signoffs s
              WHERE s.tenant_id = NEW.tenant_id AND s.version_id = NEW.version_id AND s.signed_by = actor) THEN
    RAISE EXCEPTION 'segregation of duties: one person cannot sign two levels of the same version'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.level = 'preparer' THEN
    IF app.role_rank(role) < 1 THEN
      RAISE EXCEPTION 'role % cannot prepare', role USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.level = 'reviewer' THEN
    SELECT s.signer_role INTO prep_role FROM app.workpaper_signoffs s
     WHERE s.tenant_id = NEW.tenant_id AND s.version_id = NEW.version_id AND s.level = 'preparer';
    IF prep_role IS NULL THEN
      RAISE EXCEPTION 'review requires a preparer sign-off on this version' USING ERRCODE = '23514';
    END IF;
    IF app.role_rank(role) < 2 OR app.role_rank(role) < app.role_rank(prep_role) THEN
      RAISE EXCEPTION 'reviewer (%) must be senior or above and not junior to the preparer (%)', role, prep_role
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.level = 'partner' THEN
    IF NOT EXISTS (SELECT 1 FROM app.workpaper_signoffs s
                    WHERE s.tenant_id = NEW.tenant_id AND s.version_id = NEW.version_id AND s.level = 'reviewer') THEN
      RAISE EXCEPTION 'partner approval requires a reviewer sign-off on this version' USING ERRCODE = '23514';
    END IF;
    IF role <> 'engagement_partner' THEN
      RAISE EXCEPTION 'only the engagement partner can approve' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.level IN ('reviewer', 'partner') AND NEW.step_up_assertion IS NULL THEN
    RAISE EXCEPTION 'reviewer/partner sign-off requires a step-up (WebAuthn) assertion' USING ERRCODE = '28000';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.tg_signoffs_after() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE app.workpapers
     SET status = CASE NEW.level WHEN 'preparer' THEN 'prepared'
                                 WHEN 'reviewer' THEN 'reviewed'
                                 ELSE 'approved' END::app.workpaper_status
   WHERE tenant_id = NEW.tenant_id AND id = NEW.workpaper_id;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- Evidence files
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.tg_evidence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE pe date; yrs smallint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.scan_status := 'pending';
    NEW.scanned_at  := NULL;
    SELECT e.period_end, t.record_retention_years INTO pe, yrs
      FROM app.engagements e JOIN platform.tenants t ON t.id = e.tenant_id
     WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.engagement_id;
    NEW.retain_until := greatest(NEW.retain_until, (pe + make_interval(years => yrs))::date);
    RETURN NEW;
  END IF;
  -- UPDATE: only the malware-scan verdict, only by a service principal, once.
  IF NOT app.ctx_is_service() OR OLD.scan_status <> 'pending'
     OR (to_jsonb(NEW) - 'scan_status' - 'scanned_at') <> (to_jsonb(OLD) - 'scan_status' - 'scanned_at') THEN
    RAISE EXCEPTION 'evidence records are immutable (scan verdict excepted)' USING ERRCODE = '55000';
  END IF;
  NEW.scanned_at := clock_timestamp();
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- Adjusting journal entries
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.assert_aje_balanced(p_tenant uuid, p_entry uuid) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE n bigint; net numeric;
BEGIN
  SELECT count(*), coalesce(sum(amount), 0) INTO n, net
    FROM app.adjusting_entry_lines WHERE tenant_id = p_tenant AND entry_id = p_entry;
  IF n < 2 OR net <> 0 THEN
    RAISE EXCEPTION 'entry is not balanced (% lines, net %)', n, net USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE FUNCTION app.tg_aje_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'entries are created as draft' USING ERRCODE = '23514';
  END IF;
  NEW.approved_by := NULL; NEW.approved_at := NULL;
  NEW.posted_by   := NULL; NEW.posted_at   := NULL;
  -- Gapless numbering: lock the engagement row and take the next number.
  -- Entries are never deleted (they are voided via 'rejected'), so the
  -- sequence is complete — a property auditors test for.
  UPDATE app.engagements SET aje_seq = aje_seq + 1
   WHERE tenant_id = NEW.tenant_id AND id = NEW.engagement_id
  RETURNING aje_seq INTO NEW.entry_no;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.tg_aje_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := app.require_actor();
  role  app.engagement_role;
  e     record;
  mismatch bigint;
BEGIN
  IF OLD.status IN ('posted', 'rejected') THEN
    RAISE EXCEPTION 'entry #% is % and immutable; post a reversing entry instead', OLD.entry_no, OLD.status
      USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.engagement_id, NEW.entry_no, NEW.reverses_entry_id)
     IS DISTINCT FROM (OLD.id, OLD.engagement_id, OLD.entry_no, OLD.reverses_entry_id) THEN
    RAISE EXCEPTION 'entry identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only draft entries can be edited' USING ERRCODE = '55000';
    END IF;
    NEW.approved_by := NULL; NEW.approved_at := NULL; NEW.posted_by := NULL; NEW.posted_at := NULL;
    RETURN NEW;
  END IF;

  -- No content edits smuggled in with a status transition.
  IF (NEW.entry_type, NEW.description, NEW.effective_date, NEW.workpaper_id)
     IS DISTINCT FROM (OLD.entry_type, OLD.description, OLD.effective_date, OLD.workpaper_id) THEN
    RAISE EXCEPTION 'content cannot change during a status transition' USING ERRCODE = '55000';
  END IF;

  role := app.actor_engagement_role(NEW.tenant_id, NEW.engagement_id);

  IF OLD.status = 'draft' AND NEW.status = 'proposed' THEN
    PERFORM app.assert_aje_balanced(NEW.tenant_id, NEW.id);
    NEW.approved_by := NULL; NEW.approved_at := NULL;

  ELSIF OLD.status = 'proposed' AND NEW.status = 'draft' THEN
    NEW.approved_by := NULL; NEW.approved_at := NULL;

  ELSIF OLD.status = 'proposed' AND NEW.status = 'approved' THEN
    IF role IS NULL OR role NOT IN ('manager', 'engagement_partner') THEN
      RAISE EXCEPTION 'approval requires the engagement manager or partner' USING ERRCODE = '42501';
    END IF;
    IF actor = OLD.created_by THEN
      RAISE EXCEPTION 'maker-checker: the preparer cannot approve their own entry' USING ERRCODE = '42501';
    END IF;
    PERFORM app.assert_aje_balanced(NEW.tenant_id, NEW.id);
    NEW.approved_by := actor;
    NEW.approved_at := clock_timestamp();

  ELSIF OLD.status = 'approved' AND NEW.status = 'posted' THEN
    IF role IS NULL OR role NOT IN ('manager', 'engagement_partner') THEN
      RAISE EXCEPTION 'posting requires the engagement manager or partner' USING ERRCODE = '42501';
    END IF;
    IF NEW.entry_type = 'PAJE' THEN
      RAISE EXCEPTION 'passed adjustments (PAJE) are never posted (ISA 450 summary only)' USING ERRCODE = '23514';
    END IF;
    SELECT period_start, period_end, stage INTO e FROM app.engagements
     WHERE tenant_id = NEW.tenant_id AND id = NEW.engagement_id FOR SHARE;
    IF e.stage NOT IN ('fieldwork', 'review', 'reporting') THEN
      RAISE EXCEPTION 'entries can only be posted during fieldwork, review or reporting (stage %)', e.stage
        USING ERRCODE = '55000';
    END IF;
    IF NEW.effective_date NOT BETWEEN e.period_start AND e.period_end THEN
      RAISE EXCEPTION 'effective date % is outside the audit period % .. %', NEW.effective_date, e.period_start, e.period_end
        USING ERRCODE = '23514';
    END IF;
    PERFORM app.assert_aje_balanced(NEW.tenant_id, NEW.id);
    IF NEW.reverses_entry_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM app.adjusting_entries o
                      WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.reverses_entry_id AND o.status = 'posted') THEN
        RAISE EXCEPTION 'only a posted entry can be reversed' USING ERRCODE = '23514';
      END IF;
      -- The reversal must negate the original exactly, account by account.
      SELECT count(*) INTO mismatch FROM (
        SELECT coa_account_id, sum(amount) AS amt FROM app.adjusting_entry_lines
         WHERE tenant_id = NEW.tenant_id AND entry_id IN (NEW.id, NEW.reverses_entry_id)
         GROUP BY coa_account_id HAVING sum(amount) <> 0) x;
      IF mismatch > 0 THEN
        RAISE EXCEPTION 'reversal does not exactly negate entry being reversed' USING ERRCODE = '23514';
      END IF;
    END IF;
    NEW.posted_by := actor;
    NEW.posted_at := clock_timestamp();

  ELSIF NEW.status = 'rejected' THEN
    -- Void from any open state (the number stays consumed): by the preparer
    -- or by the engagement manager/partner.
    IF NOT (actor = OLD.created_by OR coalesce(role IN ('manager', 'engagement_partner'), false)) THEN
      RAISE EXCEPTION 'only the preparer or the engagement manager/partner can void an entry' USING ERRCODE = '42501';
    END IF;

  ELSE
    RAISE EXCEPTION 'illegal entry transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.tg_aje_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END); s app.aje_status;
        postable boolean;
BEGIN
  -- FOR SHARE blocks a concurrent status transition on the header until we
  -- commit, closing the "add a line while it is being posted" race.
  SELECT status INTO s FROM app.adjusting_entries
   WHERE tenant_id = (r->>'tenant_id')::uuid AND id = (r->>'entry_id')::uuid FOR SHARE;
  IF s IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'lines can only change while the entry is draft' USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT is_postable INTO postable FROM app.coa_accounts
     WHERE tenant_id = NEW.tenant_id AND id = NEW.coa_account_id;
    IF NOT postable THEN
      RAISE EXCEPTION 'cannot post to a header (non-postable) account' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

-- ---------------------------------------------------------------------------
-- Wiring
-- ---------------------------------------------------------------------------
CREATE TRIGGER t10_stamp BEFORE INSERT OR UPDATE ON app.users FOR EACH ROW EXECUTE FUNCTION app.tg_stamp('no_actor');
CREATE TRIGGER t20_guard BEFORE UPDATE ON app.users FOR EACH ROW EXECUTE FUNCTION app.tg_users_guard();
CREATE TRIGGER t90_no_delete BEFORE DELETE ON app.users FOR EACH ROW EXECUTE FUNCTION app.tg_no_delete();

CREATE TRIGGER t10_stamp BEFORE INSERT OR UPDATE ON app.clients FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t90_no_delete BEFORE DELETE ON app.clients FOR EACH ROW EXECUTE FUNCTION app.tg_no_delete();

CREATE TRIGGER t10_stamp BEFORE INSERT OR UPDATE ON app.coa_accounts FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t90_no_delete BEFORE DELETE ON app.coa_accounts FOR EACH ROW EXECUTE FUNCTION app.tg_no_delete();

CREATE TRIGGER t10_stamp BEFORE INSERT OR UPDATE ON app.engagements FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t20_insert BEFORE INSERT ON app.engagements FOR EACH ROW EXECUTE FUNCTION app.tg_engagements_insert();
CREATE TRIGGER t20_update BEFORE UPDATE ON app.engagements FOR EACH ROW EXECUTE FUNCTION app.tg_engagements_update();
CREATE TRIGGER t90_no_delete BEFORE DELETE ON app.engagements FOR EACH ROW EXECUTE FUNCTION app.tg_no_delete();

CREATE TRIGGER t10_stamp BEFORE INSERT OR UPDATE ON app.engagement_members FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t20_guard BEFORE INSERT OR UPDATE ON app.engagement_members FOR EACH ROW EXECUTE FUNCTION app.tg_members_guard();
CREATE TRIGGER t90_no_delete BEFORE DELETE ON app.engagement_members FOR EACH ROW EXECUTE FUNCTION app.tg_no_delete();

CREATE TRIGGER t05_open BEFORE INSERT OR UPDATE OR DELETE ON app.trial_balances FOR EACH ROW EXECUTE FUNCTION app.tg_engagement_open();
CREATE TRIGGER t10_stamp BEFORE INSERT OR UPDATE ON app.trial_balances FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t20_guard BEFORE INSERT OR UPDATE ON app.trial_balances FOR EACH ROW EXECUTE FUNCTION app.tg_trial_balances_guard();
CREATE TRIGGER t90_no_delete BEFORE DELETE ON app.trial_balances FOR EACH ROW EXECUTE FUNCTION app.tg_no_delete();

CREATE TRIGGER t05_open BEFORE INSERT OR UPDATE OR DELETE ON app.tb_lines FOR EACH ROW EXECUTE FUNCTION app.tg_engagement_open();
CREATE TRIGGER t10_stamp BEFORE INSERT OR UPDATE ON app.tb_lines FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t20_guard BEFORE INSERT OR UPDATE OR DELETE ON app.tb_lines FOR EACH ROW EXECUTE FUNCTION app.tg_tb_lines_guard();

CREATE TRIGGER t05_open BEFORE INSERT OR UPDATE OR DELETE ON app.account_mappings FOR EACH ROW EXECUTE FUNCTION app.tg_engagement_open();
CREATE TRIGGER t10_stamp BEFORE INSERT OR UPDATE ON app.account_mappings FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t20_guard BEFORE INSERT OR UPDATE ON app.account_mappings FOR EACH ROW EXECUTE FUNCTION app.tg_mappings_guard();
CREATE TRIGGER t90_no_delete BEFORE DELETE ON app.account_mappings FOR EACH ROW EXECUTE FUNCTION app.tg_no_delete();

CREATE TRIGGER t05_open BEFORE INSERT OR UPDATE OR DELETE ON app.workpapers FOR EACH ROW EXECUTE FUNCTION app.tg_engagement_open();
CREATE TRIGGER t10_stamp BEFORE INSERT OR UPDATE ON app.workpapers FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t20_guard BEFORE INSERT OR UPDATE OR DELETE ON app.workpapers FOR EACH ROW EXECUTE FUNCTION app.tg_workpapers_guard();

CREATE TRIGGER t05_open BEFORE INSERT ON app.workpaper_versions FOR EACH ROW EXECUTE FUNCTION app.tg_engagement_open();
CREATE TRIGGER t10_stamp BEFORE INSERT ON app.workpaper_versions FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t20_insert BEFORE INSERT ON app.workpaper_versions FOR EACH ROW EXECUTE FUNCTION app.tg_wp_versions_insert();
CREATE TRIGGER t90_append_only BEFORE UPDATE OR DELETE ON app.workpaper_versions FOR EACH ROW EXECUTE FUNCTION app.tg_append_only();

CREATE TRIGGER t05_open BEFORE INSERT ON app.workpaper_signoffs FOR EACH ROW EXECUTE FUNCTION app.tg_engagement_open();
CREATE TRIGGER t20_insert BEFORE INSERT ON app.workpaper_signoffs FOR EACH ROW EXECUTE FUNCTION app.tg_signoffs_insert();
CREATE TRIGGER t30_after AFTER INSERT ON app.workpaper_signoffs FOR EACH ROW EXECUTE FUNCTION app.tg_signoffs_after();
CREATE TRIGGER t90_append_only BEFORE UPDATE OR DELETE ON app.workpaper_signoffs FOR EACH ROW EXECUTE FUNCTION app.tg_append_only();

CREATE TRIGGER t05_open BEFORE INSERT OR UPDATE ON app.evidence_files FOR EACH ROW EXECUTE FUNCTION app.tg_engagement_open();
CREATE TRIGGER t10_stamp BEFORE INSERT OR UPDATE ON app.evidence_files FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t20_guard BEFORE INSERT OR UPDATE ON app.evidence_files FOR EACH ROW EXECUTE FUNCTION app.tg_evidence_guard();
CREATE TRIGGER t90_no_delete BEFORE DELETE ON app.evidence_files FOR EACH ROW EXECUTE FUNCTION app.tg_no_delete();

CREATE TRIGGER t05_open BEFORE INSERT OR UPDATE OR DELETE ON app.adjusting_entries FOR EACH ROW EXECUTE FUNCTION app.tg_engagement_open();
CREATE TRIGGER t10_stamp BEFORE INSERT OR UPDATE ON app.adjusting_entries FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t20_insert BEFORE INSERT ON app.adjusting_entries FOR EACH ROW EXECUTE FUNCTION app.tg_aje_insert();
CREATE TRIGGER t20_update BEFORE UPDATE ON app.adjusting_entries FOR EACH ROW EXECUTE FUNCTION app.tg_aje_update();
CREATE TRIGGER t90_no_delete BEFORE DELETE ON app.adjusting_entries FOR EACH ROW EXECUTE FUNCTION app.tg_no_delete();

CREATE TRIGGER t05_open BEFORE INSERT OR UPDATE OR DELETE ON app.adjusting_entry_lines FOR EACH ROW EXECUTE FUNCTION app.tg_engagement_open();
CREATE TRIGGER t10_stamp BEFORE INSERT OR UPDATE ON app.adjusting_entry_lines FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t20_guard BEFORE INSERT OR UPDATE OR DELETE ON app.adjusting_entry_lines FOR EACH ROW EXECUTE FUNCTION app.tg_aje_lines_guard();

-- TRUNCATE guard on every app table (and partitions).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.oid::regclass AS tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('CREATE TRIGGER t99_no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION app.tg_no_truncate()', r.tbl);
  END LOOP;
END
$$;
