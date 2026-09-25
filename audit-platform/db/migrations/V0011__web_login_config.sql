-- =============================================================================
-- V0011 — Login configuration for the web client
-- -----------------------------------------------------------------------------
-- The browser app runs on the tenant's host and signs users in against the
-- tenant's OWN IdP (authorization code + PKCE). It needs the issuer and the
-- public client id registered for the web app. Both are public by nature
-- (they appear in every login redirect); nothing else about the tenant is
-- exposed, and an unknown or inactive tenant is indistinguishable from one
-- without a web client.
-- =============================================================================
SET ROLE audit_owner;

ALTER TABLE platform.tenants ADD COLUMN oidc_web_client_id text
  CHECK (oidc_web_client_id IS NULL OR oidc_web_client_id ~ '^[A-Za-z0-9._:-]{1,128}$');

CREATE FUNCTION platform.tenant_login_config(p_tenant_slug text)
RETURNS TABLE (oidc_issuer text, oidc_web_client_id text, home_region text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.oidc_issuer, t.oidc_web_client_id, t.home_region
    FROM platform.tenants t
   WHERE t.slug = p_tenant_slug AND t.status = 'active'
     AND t.oidc_issuer IS NOT NULL AND t.oidc_web_client_id IS NOT NULL
$$;

CREATE FUNCTION platform.set_web_client(p_tenant uuid, p_client_id text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE platform.tenants SET oidc_web_client_id = p_client_id WHERE id = p_tenant
$$;

GRANT EXECUTE ON FUNCTION platform.tenant_login_config(text) TO audit_app;
GRANT EXECUTE ON FUNCTION platform.set_web_client(uuid, text) TO audit_provisioner;
RESET ROLE;
