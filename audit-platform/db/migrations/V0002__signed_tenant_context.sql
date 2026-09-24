-- =============================================================================
-- V0002 — Signed tenant context
-- -----------------------------------------------------------------------------
-- Classic RLS keys policies off a plain GUC (`SET app.tenant_id = ...`). That
-- is only as strong as the application's SQL-injection resistance: any injected
-- `SELECT set_config('app.tenant_id', '<victim>', true)` pivots tenants.
--
-- Here the GUC `app.ctx` carries an HMAC-signed, short-lived token minted by the
-- backend (which holds the key in memory, sourced from a secrets manager). The
-- database verifies it with the same key, stored in a table only the owner can
-- read. An attacker with arbitrary SQL in the app's session can read and replay
-- *their own* context but cannot forge another tenant's.
--
-- Token format (all ASCII, '.'-separated, 7 parts):
--   v1.<key_id>.<tenant_uuid>.<user_uuid>.<flags>.<exp_unix>.<hmac_sha256_hex>
--   flags: '-' = staff, 'A' = firm admin, 'S' = service principal,
--          'C' = client-portal contact (combinations allowed, e.g. 'A').
--   MAC input: the first six parts joined by '.' (UTF-8).
--
-- Operational rules (enforced in the backend, see backend/src/database):
--   * always `set_config('app.ctx', $1, true)` — transaction-local, bind param
--     (bind params are not shown in pg_stat_activity / pg_stat_statements);
--   * `log_parameter_max_length = 0` so tokens never reach server logs;
--   * TTL ≤ 120 s; keys rotated via key_id (old key => 'verify_only').
-- =============================================================================
SET ROLE audit_owner;

CREATE TABLE sec.context_signing_keys (
  key_id     text        PRIMARY KEY CHECK (key_id ~ '^[a-z0-9-]{1,32}$'),
  secret     bytea       NOT NULL CHECK (octet_length(secret) >= 32),
  status     text        NOT NULL CHECK (status IN ('active', 'verify_only', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE sec.context_signing_keys IS
  'HMAC keys for app.ctx. Readable only by audit_owner via sec.verified_ctx(). Populate from the secrets manager at deploy time; never commit secrets.';

CREATE TYPE sec.ctx AS (
  tenant_id     uuid,
  user_id       uuid,
  is_firm_admin boolean,
  is_service    boolean,
  is_client     boolean
);

-- Returns NULL when no context is set (=> every RLS policy evaluates false =>
-- zero rows, i.e. fail closed). RAISES on a malformed, forged or expired token
-- so tampering is loud and lands in the logs / SIEM.
CREATE FUNCTION sec.verified_ctx() RETURNS sec.ctx
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, ext, pg_temp
AS $$
DECLARE
  raw    text := current_setting('app.ctx', true);
  parts  text[];
  k      bytea;
  mac    text;
  result sec.ctx;
BEGIN
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;

  parts := string_to_array(raw, '.');
  IF coalesce(array_length(parts, 1), 0) <> 7 OR parts[1] <> 'v1'
     OR parts[5] !~ '^(-|[ASC]{1,3})$' OR parts[6] !~ '^[0-9]{1,12}$'
     OR parts[7] !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'tenant context malformed' USING ERRCODE = '28000';
  END IF;

  SELECT secret INTO k
    FROM sec.context_signing_keys
   WHERE key_id = parts[2] AND status IN ('active', 'verify_only');
  IF k IS NULL THEN
    RAISE EXCEPTION 'tenant context key unknown or retired' USING ERRCODE = '28000';
  END IF;

  mac := encode(ext.hmac(convert_to(array_to_string(parts[1:6], '.'), 'UTF8'), k, 'sha256'), 'hex');
  IF mac <> parts[7] THEN
    RAISE EXCEPTION 'tenant context signature invalid' USING ERRCODE = '28000';
  END IF;

  IF parts[6]::bigint < extract(epoch FROM now())::bigint THEN
    RAISE EXCEPTION 'tenant context expired' USING ERRCODE = '28000';
  END IF;

  result.tenant_id     := parts[3]::uuid;
  result.user_id       := parts[4]::uuid;
  result.is_firm_admin := position('A' IN parts[5]) > 0;
  result.is_service    := position('S' IN parts[5]) > 0;
  result.is_client     := position('C' IN parts[5]) > 0;

  IF result.is_client AND (result.is_firm_admin OR result.is_service) THEN
    RAISE EXCEPTION 'tenant context flags inconsistent' USING ERRCODE = '28000';
  END IF;
  RETURN result;
END
$$;

-- Thin accessors. Policies call them wrapped in a scalar sub-select, e.g.
-- `tenant_id = (SELECT app.current_tenant_id())`, so the planner evaluates the
-- HMAC once per statement (InitPlan) instead of once per row.
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT (sec.verified_ctx()).tenant_id $$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT (sec.verified_ctx()).user_id $$;

CREATE FUNCTION app.ctx_is_firm_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce((sec.verified_ctx()).is_firm_admin, false) $$;

CREATE FUNCTION app.ctx_is_service() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce((sec.verified_ctx()).is_service, false) $$;

CREATE FUNCTION app.ctx_is_client() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce((sec.verified_ctx()).is_client, false) $$;

-- Helper for triggers: the authenticated actor or a hard failure.
CREATE FUNCTION app.require_actor() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE u uuid := app.current_user_id();
BEGIN
  IF u IS NULL THEN
    RAISE EXCEPTION 'no authenticated tenant context' USING ERRCODE = '28000';
  END IF;
  RETURN u;
END
$$;
