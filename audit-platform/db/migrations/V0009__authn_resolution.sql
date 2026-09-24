-- =============================================================================
-- V0009 — Pre-context identity resolution & context entry point
-- -----------------------------------------------------------------------------
-- Chicken-and-egg: to mint a context the backend must know the user's id, but
-- app.users is invisible without a context. platform.resolve_principal() is the
-- single, narrow, SECURITY DEFINER door for that lookup. It binds the tenant
-- (from the request host) to the tenant's OWN OIDC issuer, so a valid token
-- from firm A's IdP can never resolve to a user in firm B ("issuer confusion").
-- =============================================================================
SET ROLE audit_owner;

ALTER TABLE platform.tenants ADD COLUMN oidc_issuer text
  CHECK (oidc_issuer IS NULL OR oidc_issuer ~ '^https://[^\s]+$');
-- Enforce uniqueness so one IdP issuer cannot front two tenants.
CREATE UNIQUE INDEX tenants_oidc_issuer_uq ON platform.tenants (oidc_issuer) WHERE oidc_issuer IS NOT NULL;

CREATE FUNCTION platform.resolve_principal(p_tenant_slug text, p_issuer text, p_subject text)
RETURNS TABLE (tenant_id uuid, user_id uuid, flags text, home_region text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.id, u.id,
         CASE WHEN u.is_firm_admin THEN 'A' ELSE '' END
         || CASE WHEN u.user_kind = 'service' THEN 'S' ELSE '' END
         || CASE WHEN u.user_kind = 'client_contact' THEN 'C' ELSE '' END,
         t.home_region
    FROM platform.tenants t
    JOIN app.users u ON u.tenant_id = t.id
   WHERE t.slug = p_tenant_slug
     AND t.oidc_issuer = p_issuer
     AND t.status = 'active'
     AND u.idp_subject = p_subject
     AND u.status = 'active'
$$;
COMMENT ON FUNCTION platform.resolve_principal(text, text, text) IS
  'Pre-context principal lookup. Returns zero rows for any mismatch and never says which part failed.';

-- Step 1 of authentication: slug (from Host) -> the tenant's registered
-- issuer and home region. The backend verifies the JWT ONLY against this
-- issuer's JWKS; it never fetches keys from an attacker-supplied `iss` (SSRF
-- and issuer-confusion), and it refuses tenants homed in another region.
CREATE FUNCTION platform.tenant_directory(p_tenant_slug text)
RETURNS TABLE (tenant_id uuid, oidc_issuer text, home_region text, status platform.tenant_status)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.id, t.oidc_issuer, t.home_region, t.status FROM platform.tenants t WHERE t.slug = p_tenant_slug
$$;

-- The owner is subject to FORCE RLS on app.users, so this definer lookup needs
-- a narrow policy of its own: owner-only, SELECT-only. Any new SECURITY
-- DEFINER function reading app.users inherits this visibility — review them.
CREATE POLICY owner_principal_lookup ON app.users AS PERMISSIVE FOR SELECT TO audit_owner USING (true);

-- One round-trip transaction entry: refuse if a context is already present on
-- this pooled connection (it would indicate a leak), set it transaction-local,
-- and verify it immediately so a bad token fails before any business SQL runs.
CREATE FUNCTION app.enter_context(p_token text)
RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE plpgsql VOLATILE
AS $$
DECLARE prior text := current_setting('app.ctx', true);
BEGIN
  IF prior IS NOT NULL AND prior <> '' THEN
    RAISE EXCEPTION 'tenant context already present on this connection' USING ERRCODE = '28000';
  END IF;
  PERFORM set_config('app.ctx', p_token, true);
  RETURN QUERY SELECT (c).tenant_id, (c).user_id FROM (SELECT sec.verified_ctx() AS c) x;
END
$$;

GRANT EXECUTE ON FUNCTION platform.tenant_directory(text) TO audit_app;
GRANT EXECUTE ON FUNCTION platform.resolve_principal(text, text, text) TO audit_app;
GRANT EXECUTE ON FUNCTION app.enter_context(text) TO audit_app;
RESET ROLE;
