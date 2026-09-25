-- =============================================================================
-- V0010 — Trial-balance ingestion & mapping cascade (Phase 3, slice 1)
-- -----------------------------------------------------------------------------
-- Flow:
--   1. A staff member of the engagement uploads a file  -> app.tb_imports (received)
--   2. The ingestion worker, acting as the tenant's INGESTION SERVICE
--      PRINCIPAL, parses it in the sandbox, writes trial_balances + tb_lines,
--      closes the import (control totals re-verified in-DB, V0005) and marks
--      the import imported (or failed, with a safe reason).
--   3. The same principal writes mapping SUGGESTIONS (carry-forward, firm
--      rules, exact matches, optionally an LLM). Only humans decide (V0005).
--
-- Why a service principal and not the uploader's identity for steps 2-3?
-- So that the database can tell machine output from human decisions: machine
-- sources may only be written by a service principal, 'manual' only by staff,
-- and service principals can never accept or reject (V0005).
-- =============================================================================
SET ROLE audit_owner;

-- ---------------------------------------------------------------------------
-- Tenant policy: LLM mapping is a cross-border / sub-processor transfer for
-- most MENA tenants (Jordan PDPL 2023, KSA PDPL). Off unless the control plane
-- records an explicit decision for the tenant.
-- ---------------------------------------------------------------------------
ALTER TABLE platform.tenants ADD COLUMN llm_mapping_allowed boolean NOT NULL DEFAULT false;

CREATE FUNCTION platform.set_llm_mapping_allowed(p_tenant uuid, p_allowed boolean)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE platform.tenants SET llm_mapping_allowed = p_allowed WHERE id = p_tenant
$$;

-- ---------------------------------------------------------------------------
-- Service principals
-- ---------------------------------------------------------------------------
-- A service principal must never be reachable through a firm's IdP: whoever
-- administers that IdP could otherwise mint `sub = <service subject>` and log
-- in as a principal that bypasses ethical walls. Service contexts are minted
-- only by the backend's workers.
CREATE OR REPLACE FUNCTION platform.resolve_principal(p_tenant_slug text, p_issuer text, p_subject text)
RETURNS TABLE (tenant_id uuid, user_id uuid, flags text, home_region text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.id, u.id,
         CASE WHEN u.is_firm_admin THEN 'A' ELSE '' END
         || CASE WHEN u.user_kind = 'client_contact' THEN 'C' ELSE '' END,
         t.home_region
    FROM platform.tenants t
    JOIN app.users u ON u.tenant_id = t.id
   WHERE t.slug = p_tenant_slug
     AND t.oidc_issuer = p_issuer
     AND t.status = 'active'
     AND u.idp_subject = p_subject
     AND u.status = 'active'
     AND u.user_kind <> 'service'
$$;

-- Idempotently create a tenant's service principal. The subject lives in the
-- reserved "system:" namespace; an IdP subject can never resolve to it (above).
CREATE FUNCTION platform.ensure_service_principal(p_tenant uuid, p_subject text, p_display_name text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, ext, pg_temp
AS $$
DECLARE uid uuid;
BEGIN
  IF p_subject !~ '^system:[a-z][a-z0-9-]{1,40}$' THEN
    RAISE EXCEPTION 'service principal subjects must match system:<name>' USING ERRCODE = '22023';
  END IF;
  SELECT u.id INTO uid FROM app.users u
   WHERE u.tenant_id = p_tenant AND u.idp_subject = p_subject AND u.user_kind = 'service';
  IF FOUND THEN
    RETURN uid;
  END IF;
  uid := gen_random_uuid();
  -- Bootstrap pattern as in provision_tenant: a short-lived admin context for
  -- this one insert, cleared before returning.
  PERFORM set_config('app.ctx', sec.mint_ctx(p_tenant, uid, 'A', 30), true);
  INSERT INTO app.users (tenant_id, id, idp_subject, email, display_name, user_kind, status)
  VALUES (p_tenant, uid, p_subject, replace(p_subject, ':', '-') || '@service.invalid', p_display_name,
          'service', 'active');
  PERFORM set_config('app.ctx', '', true);
  RETURN uid;
END
$$;

-- Workers look up the principal they act as. Returns NULL unless it exists and is active.
CREATE FUNCTION platform.service_principal_id(p_tenant uuid, p_subject text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id FROM app.users u
   WHERE u.tenant_id = p_tenant AND u.idp_subject = p_subject
     AND u.user_kind = 'service' AND u.status = 'active'
     AND p_subject LIKE 'system:%'
$$;

-- New tenants get their ingestion principal at provisioning time.
CREATE OR REPLACE FUNCTION platform.provision_tenant(
  p_slug text, p_legal_name text, p_country char(2), p_home_region text, p_cell text,
  p_kms_key_ref text, p_admin_subject text, p_admin_email text, p_admin_name text,
  p_isolation platform.isolation_tier DEFAULT 'pooled')
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, ext, pg_temp
AS $$
DECLARE
  tid uuid := gen_random_uuid();
  uid uuid := gen_random_uuid();
BEGIN
  INSERT INTO platform.tenants (id, slug, legal_name, country_code, home_region, deployment_cell,
                                isolation_tier, kms_key_ref, status)
  VALUES (tid, p_slug, p_legal_name, p_country, p_home_region, p_cell, p_isolation, p_kms_key_ref, 'active');

  INSERT INTO audit.chain_heads (tenant_id, last_seq, last_hash) VALUES (tid, 0, audit.genesis());

  PERFORM set_config('app.ctx', sec.mint_ctx(tid, uid, 'A', 30), true);
  INSERT INTO app.users (tenant_id, id, idp_subject, email, display_name, user_kind,
                         professional_rank, is_firm_admin, status)
  VALUES (tid, uid, p_admin_subject, p_admin_email, p_admin_name, 'staff', 'partner', true, 'invited');
  PERFORM set_config('app.ctx', '', true);

  PERFORM platform.ensure_service_principal(tid, 'system:tb-ingestion', 'TB ingestion service');
  RETURN tid;
END
$$;

-- Existing tenants (none in production yet; keeps upgraded databases uniform).
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM platform.tenants LOOP
    PERFORM platform.ensure_service_principal(t, 'system:tb-ingestion', 'TB ingestion service');
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Imports (one row per uploaded file; the worker's job record)
-- ---------------------------------------------------------------------------
CREATE TYPE app.tb_import_status AS ENUM ('received', 'processing', 'imported', 'failed');
CREATE TYPE app.tb_source_format AS ENUM ('csv', 'xlsx');

CREATE TABLE app.tb_imports (
  tenant_id          uuid        NOT NULL,
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  engagement_id      uuid        NOT NULL,
  tb_kind            app.tb_kind NOT NULL DEFAULT 'current_unadjusted',
  as_of_date         date        NOT NULL,
  currency           app.currency_code NOT NULL,
  source_object_key  text        NOT NULL,
  source_sha256      app.sha256  NOT NULL,
  source_filename    text        NOT NULL CHECK (length(source_filename) BETWEEN 1 AND 255
                                                 AND source_filename !~ '[[:cntrl:]]'),
  source_format      app.tb_source_format NOT NULL,
  source_size_bytes  bigint      NOT NULL CHECK (source_size_bytes > 0),
  status             app.tb_import_status NOT NULL DEFAULT 'received',
  trial_balance_id   uuid,
  parser_version     text        CHECK (length(parser_version) <= 64),
  -- Parser warnings (counts + example row numbers); bounded, never raw cell text.
  report             jsonb       CHECK (report IS NULL OR pg_column_size(report) <= 65536),
  failure_code       text        CHECK (failure_code ~ '^[a-z_]{1,64}$'),
  failure_message    text        CHECK (length(failure_message) <= 500),
  mapping_summary    jsonb       CHECK (mapping_summary IS NULL OR pg_column_size(mapping_summary) <= 8192),
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by         uuid        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, engagement_id) REFERENCES app.engagements (tenant_id, id),
  FOREIGN KEY (tenant_id, trial_balance_id, engagement_id)
    REFERENCES app.trial_balances (tenant_id, id, engagement_id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.users (tenant_id, id),
  CHECK (source_object_key LIKE 'tenants/' || tenant_id::text || '/engagements/' || engagement_id::text || '/tb/%'),
  CHECK ((status = 'imported') = (trial_balance_id IS NOT NULL)),
  CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CHECK ((status IN ('imported', 'failed')) = (completed_at IS NOT NULL))
);
CREATE INDEX tb_imports_engagement_ix ON app.tb_imports (tenant_id, engagement_id, created_at DESC);

CREATE FUNCTION app.tg_tb_imports_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  kind app.user_kind;
  tb   record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT u.user_kind INTO kind FROM app.users u
     WHERE u.tenant_id = NEW.tenant_id AND u.id = app.require_actor();
    IF app.ctx_is_service() OR kind IS DISTINCT FROM 'staff' THEN
      RAISE EXCEPTION 'trial balances are uploaded by engagement staff' USING ERRCODE = '42501';
    END IF;
    IF NEW.status <> 'received' THEN
      RAISE EXCEPTION 'an import starts in status received' USING ERRCODE = '23514';
    END IF;
    NEW.trial_balance_id := NULL; NEW.parser_version := NULL; NEW.report := NULL;
    NEW.failure_code := NULL; NEW.failure_message := NULL; NEW.mapping_summary := NULL;
    NEW.completed_at := NULL;
    RETURN NEW;
  END IF;

  IF NOT coalesce(app.ctx_is_service(), false) THEN
    RAISE EXCEPTION 'import status is managed by the ingestion service' USING ERRCODE = '42501';
  END IF;
  IF (NEW.engagement_id, NEW.tb_kind, NEW.as_of_date, NEW.currency, NEW.source_object_key, NEW.source_sha256,
      NEW.source_filename, NEW.source_format, NEW.source_size_bytes)
     IS DISTINCT FROM
     (OLD.engagement_id, OLD.tb_kind, OLD.as_of_date, OLD.currency, OLD.source_object_key, OLD.source_sha256,
      OLD.source_filename, OLD.source_format, OLD.source_size_bytes) THEN
    RAISE EXCEPTION 'import provenance is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.status = OLD.status THEN
    -- The only in-place change: re-running the mapping cascade on an imported TB.
    IF OLD.status = 'imported'
       AND (NEW.trial_balance_id, NEW.parser_version, NEW.report, NEW.failure_code, NEW.failure_message,
            NEW.completed_at)
           IS NOT DISTINCT FROM
           (OLD.trial_balance_id, OLD.parser_version, OLD.report, OLD.failure_code, OLD.failure_message,
            OLD.completed_at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'import results are immutable' USING ERRCODE = '55000';
  END IF;

  IF NOT ((OLD.status = 'received' AND NEW.status IN ('processing', 'failed'))
          OR (OLD.status = 'processing' AND NEW.status IN ('imported', 'failed'))) THEN
    RAISE EXCEPTION 'illegal import transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'imported' THEN
    -- Bind the import to the TB built from ITS file (same bytes, same key, same kind).
    SELECT t.source_sha256, t.source_object_key, t.tb_kind, t.status INTO tb
      FROM app.trial_balances t WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.trial_balance_id;
    IF NOT FOUND OR tb.source_sha256 <> NEW.source_sha256 OR tb.source_object_key <> NEW.source_object_key
       OR tb.tb_kind <> NEW.tb_kind OR tb.status <> 'imported' THEN
      RAISE EXCEPTION 'an import must reference the closed trial balance built from its own file'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW.trial_balance_id := NULL;
  END IF;
  NEW.completed_at := CASE WHEN NEW.status IN ('imported', 'failed') THEN clock_timestamp() END;
  RETURN NEW;
END
$$;

CREATE TRIGGER t05_open    BEFORE INSERT OR UPDATE ON app.tb_imports FOR EACH ROW EXECUTE FUNCTION app.tg_engagement_open();
CREATE TRIGGER t10_stamp   BEFORE INSERT OR UPDATE ON app.tb_imports FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t20_guard   BEFORE INSERT OR UPDATE ON app.tb_imports FOR EACH ROW EXECUTE FUNCTION app.tg_tb_imports_guard();
CREATE TRIGGER t90_no_delete BEFORE DELETE ON app.tb_imports FOR EACH ROW EXECUTE FUNCTION app.tg_no_delete();
CREATE TRIGGER t99_no_truncate BEFORE TRUNCATE ON app.tb_imports FOR EACH STATEMENT EXECUTE FUNCTION app.tg_no_truncate();

-- ---------------------------------------------------------------------------
-- Firm mapping rules (cascade stage 1). No regular expressions: patterns are
-- evaluated by the worker as prefix / range / normalised-substring tests, so a
-- rule cannot be a ReDoS vector.
-- ---------------------------------------------------------------------------
CREATE TYPE app.mapping_rule_kind AS ENUM ('code_prefix', 'code_range', 'name_contains');

CREATE TABLE app.mapping_rules (
  tenant_id       uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  priority        integer     NOT NULL CHECK (priority BETWEEN 0 AND 100000),
  kind            app.mapping_rule_kind NOT NULL,
  pattern         text        NOT NULL CHECK (length(pattern) BETWEEN 1 AND 128 AND pattern !~ '[[:cntrl:]]'),
  pattern_to      text        CHECK (length(pattern_to) BETWEEN 1 AND 128 AND pattern_to !~ '[[:cntrl:]]'),
  coa_account_id  uuid        NOT NULL,
  description     text        CHECK (length(description) <= 500),
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, coa_account_id) REFERENCES app.coa_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)     REFERENCES app.users (tenant_id, id),
  CHECK ((kind = 'code_range') = (pattern_to IS NOT NULL))
);
CREATE INDEX mapping_rules_active_ix ON app.mapping_rules (tenant_id, priority) WHERE is_active;

-- ---------------------------------------------------------------------------
-- Mappings and rules must point at postable (leaf) accounts: a mapping to a
-- header would be double-counted by fs_rollup's ancestor explosion.
-- Machine sources are written only by service principals; 'manual' only by
-- humans, so provenance in the audit trail cannot be dressed up either way.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.tg_coa_postable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  SELECT c.is_postable INTO ok FROM app.coa_accounts c
   WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.coa_account_id;
  IF ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'mappings must target a postable (leaf) account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.tg_mappings_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'manual' AND coalesce(app.ctx_is_service(), false) THEN
    RAISE EXCEPTION 'a service principal cannot record a manual mapping' USING ERRCODE = '42501';
  ELSIF NEW.source <> 'manual' AND NOT coalesce(app.ctx_is_service(), false) THEN
    RAISE EXCEPTION 'machine mapping sources are written only by a service principal' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER t25_postable   BEFORE INSERT ON app.account_mappings FOR EACH ROW EXECUTE FUNCTION app.tg_coa_postable();
CREATE TRIGGER t26_provenance BEFORE INSERT ON app.account_mappings FOR EACH ROW EXECUTE FUNCTION app.tg_mappings_provenance();

CREATE TRIGGER t10_stamp    BEFORE INSERT OR UPDATE ON app.mapping_rules FOR EACH ROW EXECUTE FUNCTION app.tg_stamp();
CREATE TRIGGER t25_postable BEFORE INSERT OR UPDATE ON app.mapping_rules FOR EACH ROW EXECUTE FUNCTION app.tg_coa_postable();
CREATE TRIGGER t90_no_delete BEFORE DELETE ON app.mapping_rules FOR EACH ROW EXECUTE FUNCTION app.tg_no_delete();
CREATE TRIGGER t99_no_truncate BEFORE TRUNCATE ON app.mapping_rules FOR EACH STATEMENT EXECUTE FUNCTION app.tg_no_truncate();

-- ---------------------------------------------------------------------------
-- Row-level security (same two layers as V0004)
-- ---------------------------------------------------------------------------
ALTER TABLE app.tb_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tb_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tb_imports AS PERMISSIVE FOR ALL
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY engagement_wall ON app.tb_imports AS RESTRICTIVE FOR ALL
  USING (NOT (SELECT app.ctx_is_client())
         AND ((SELECT app.ctx_is_service())
              OR engagement_id IN (SELECT m.engagement_id FROM app.engagement_members m
                                    WHERE m.user_id = (SELECT app.current_user_id()) AND m.removed_at IS NULL)))
  WITH CHECK (NOT (SELECT app.ctx_is_client())
              AND ((SELECT app.ctx_is_service())
                   OR engagement_id IN (SELECT m.engagement_id FROM app.engagement_members m
                                         WHERE m.user_id = (SELECT app.current_user_id()) AND m.removed_at IS NULL)));

ALTER TABLE app.mapping_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mapping_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.mapping_rules AS PERMISSIVE FOR ALL
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY staff_only ON app.mapping_rules AS RESTRICTIVE FOR SELECT
  USING (NOT (SELECT app.ctx_is_client()));
CREATE POLICY admin_writes_ins ON app.mapping_rules AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT app.ctx_is_firm_admin()));
CREATE POLICY admin_writes_upd ON app.mapping_rules AS RESTRICTIVE FOR UPDATE
  USING ((SELECT app.ctx_is_firm_admin()));

-- ---------------------------------------------------------------------------
-- Audit chain & grants
-- ---------------------------------------------------------------------------
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.tb_imports    FOR EACH ROW EXECUTE FUNCTION audit.tg_record();
CREATE TRIGGER t95_audit AFTER INSERT OR UPDATE OR DELETE ON app.mapping_rules FOR EACH ROW EXECUTE FUNCTION audit.tg_record();

GRANT SELECT, INSERT, UPDATE ON app.tb_imports, app.mapping_rules TO audit_app;
GRANT EXECUTE ON FUNCTION platform.service_principal_id(uuid, text) TO audit_app;
GRANT EXECUTE ON FUNCTION platform.ensure_service_principal(uuid, text, text),
                          platform.set_llm_mapping_allowed(uuid, boolean) TO audit_provisioner;
RESET ROLE;
