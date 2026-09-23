-- =============================================================================
-- V0001 — Roles, schemas, extensions
-- -----------------------------------------------------------------------------
-- Role model (least privilege, no standing BYPASSRLS anywhere):
--
--   audit_owner        NOLOGIN. Owns every object. Migrations run as
--                      `SET ROLE audit_owner`. Tables use FORCE ROW LEVEL
--                      SECURITY so even the owner is subject to tenant policies.
--   audit_app          NOLOGIN, NOBYPASSRLS. Runtime privileges of the API and
--                      workers. The actual login role (IAM-auth or rotated
--                      secret) is a member created per environment, NOT here.
--   audit_provisioner  NOLOGIN. Control-plane: may only EXECUTE the tenant
--                      provisioning function.
--   audit_anchor       NOLOGIN. Chain-anchoring job: reads chain heads, writes
--                      anchor receipts. Cannot touch business data.
--
-- Nothing here may be granted to PUBLIC.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_owner') THEN
    CREATE ROLE audit_owner NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_app') THEN
    CREATE ROLE audit_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_provisioner') THEN
    CREATE ROLE audit_provisioner NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_anchor') THEN
    CREATE ROLE audit_anchor NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- Extensions live in a dedicated schema so SECURITY DEFINER functions can pin
-- `search_path = pg_catalog, ext, pg_temp` without trusting `public`.
CREATE SCHEMA IF NOT EXISTS ext;
REVOKE ALL ON SCHEMA ext FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA ext;  -- hmac(), digest()
CREATE EXTENSION IF NOT EXISTS ltree    WITH SCHEMA ext;  -- COA hierarchy roll-ups

-- Harden `public`: nobody creates objects there (default in PG15+, made explicit).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION audit_owner;  -- control plane (tenants)
CREATE SCHEMA IF NOT EXISTS sec      AUTHORIZATION audit_owner;  -- signed tenant context
CREATE SCHEMA IF NOT EXISTS app      AUTHORIZATION audit_owner;  -- tenant business data
CREATE SCHEMA IF NOT EXISTS audit    AUTHORIZATION audit_owner;  -- tamper-evident event chain

REVOKE ALL ON SCHEMA platform, sec, app, audit FROM PUBLIC;
GRANT USAGE ON SCHEMA ext TO audit_owner, audit_app;

-- Functions are EXECUTE-able by PUBLIC by default. Kill that for everything the
-- owner creates from here on; grants are made explicitly in V0008.
ALTER DEFAULT PRIVILEGES FOR ROLE audit_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE audit_owner REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE audit_owner REVOKE ALL ON SEQUENCES FROM PUBLIC;
