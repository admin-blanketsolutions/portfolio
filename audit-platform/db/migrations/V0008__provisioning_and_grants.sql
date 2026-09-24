-- =============================================================================
-- V0008 — Tenant provisioning & least-privilege grants
-- =============================================================================
SET ROLE audit_owner;

-- Mint a context token inside the database. NOT granted to anyone: used by the
-- provisioning function (and by the SQL test-suite as superuser). The backend
-- mints tokens itself (backend/src/tenancy/context-signer.ts) with the same key.
CREATE FUNCTION sec.mint_ctx(p_tenant uuid, p_user uuid, p_flags text, p_ttl_seconds int DEFAULT 60)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, ext, pg_temp
AS $$
DECLARE
  k   record;
  pay text;
BEGIN
  SELECT key_id, secret INTO k FROM sec.context_signing_keys
   WHERE status = 'active' ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no active context signing key';
  END IF;
  pay := format('v1.%s.%s.%s.%s.%s', k.key_id, p_tenant, p_user, coalesce(nullif(p_flags, ''), '-'),
                extract(epoch FROM clock_timestamp())::bigint + p_ttl_seconds);
  RETURN pay || '.' || encode(ext.hmac(convert_to(pay, 'UTF8'), k.secret, 'sha256'), 'hex');
END
$$;

-- Control-plane provisioning: tenant row, genesis chain head, first firm admin.
CREATE FUNCTION platform.provision_tenant(
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

  -- Act as the new tenant's bootstrap admin for the rest of this transaction.
  PERFORM set_config('app.ctx', sec.mint_ctx(tid, uid, 'A', 30), true);
  INSERT INTO app.users (tenant_id, id, idp_subject, email, display_name, user_kind,
                         professional_rank, is_firm_admin, status)
  VALUES (tid, uid, p_admin_subject, p_admin_email, p_admin_name, 'staff', 'partner', true, 'invited');
  PERFORM set_config('app.ctx', '', true);
  RETURN tid;
END
$$;

-- ---------------------------------------------------------------------------
-- Grants — audit_app
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA platform, sec, app, audit TO audit_app;
GRANT SELECT ON platform.tenants TO audit_app;
GRANT EXECUTE ON FUNCTION sec.verified_ctx() TO audit_app, audit_anchor;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO audit_app;
GRANT EXECUTE ON FUNCTION audit.verify_chain(uuid) TO audit_app, audit_anchor;

GRANT SELECT, INSERT, UPDATE         ON app.users, app.clients, app.coa_accounts,
                                        app.engagements, app.engagement_members,
                                        app.trial_balances, app.account_mappings,
                                        app.evidence_files, app.adjusting_entries TO audit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.tb_lines, app.workpapers,
                                        app.adjusting_entry_lines TO audit_app;   -- triggers limit DELETE to drafts/imports
GRANT SELECT, INSERT                 ON app.workpaper_versions, app.workpaper_signoffs TO audit_app;
GRANT SELECT                         ON audit.events TO audit_app;
-- Deliberately absent: TRUNCATE, REFERENCES, TRIGGER; any grant on partitions
-- (tb_lines_p*), sec.context_signing_keys, audit.chain_heads, audit.anchors.

-- ---------------------------------------------------------------------------
-- Grants — anchoring job & provisioner
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA audit, sec, app TO audit_anchor;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id(),
                          app.ctx_is_firm_admin(), app.ctx_is_service(), app.ctx_is_client() TO audit_anchor;
GRANT SELECT ON audit.chain_heads TO audit_anchor;
GRANT SELECT, INSERT ON audit.anchors TO audit_anchor;

GRANT USAGE ON SCHEMA platform TO audit_provisioner;
GRANT EXECUTE ON FUNCTION platform.provision_tenant(text, text, char, text, text, text, text, text, text,
                                                    platform.isolation_tier) TO audit_provisioner;
RESET ROLE;
