-- =============================================================================
-- Principal resolution (issuer binding) and the context entry point.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
UPDATE platform.tenants SET oidc_issuer = 'https://login.alpha.test/' WHERE slug = 'alpha-audit';
UPDATE platform.tenants SET oidc_issuer = 'https://login.beta.test/'  WHERE slug = 'beta-audit';
SELECT test.login('alpha', 'admin') \gset
UPDATE app.users SET status = 'suspended' WHERE email = 'junior2@alpha.test';
SELECT test.logout();
SET LOCAL ROLE audit_app;

DO $$
DECLARE r record; n int;
BEGIN
  SELECT * INTO r FROM platform.tenant_directory('alpha-audit');
  ASSERT r.oidc_issuer = 'https://login.alpha.test/' AND r.status = 'active', 'A0 directory lookup';
  SELECT * INTO r FROM platform.resolve_principal('alpha-audit', 'https://login.alpha.test/', 'idp|alpha-partner');
  ASSERT r.user_id = test.uid('alpha', 'partner') AND r.flags = '', 'A1 partner resolves with no flags';
  ASSERT (SELECT flags FROM platform.resolve_principal('alpha-audit', 'https://login.alpha.test/', 'idp|alpha-admin')) = 'A', 'A1 admin flag';
  -- A1b Service principals are never reachable through an IdP token (V0010): whoever runs the
  -- firm's IdP could otherwise mint their subject and bypass the ethical walls.
  SELECT count(*) INTO n FROM platform.resolve_principal('alpha-audit', 'https://login.alpha.test/', 'idp|alpha-svc');
  ASSERT n = 0, 'A1b service principal must not resolve via OIDC';
  SELECT count(*) INTO n FROM platform.resolve_principal('alpha-audit', 'https://login.alpha.test/', 'system:tb-ingestion');
  ASSERT n = 0, 'A1b ingestion principal must not resolve via OIDC';
  ASSERT platform.service_principal_id(test.tenant('alpha'), 'system:tb-ingestion') IS NOT NULL, 'A1b worker lookup';
  ASSERT platform.service_principal_id(test.tenant('alpha'), 'idp|alpha-partner') IS NULL, 'A1b lookup is service-only';
  ASSERT (SELECT flags FROM platform.resolve_principal('alpha-audit', 'https://login.alpha.test/', 'idp|alpha-client')) = 'C', 'A1 client flag';

  -- A2 Issuer confusion: beta's IdP cannot log anyone into alpha, and vice versa.
  SELECT count(*) INTO n FROM platform.resolve_principal('alpha-audit', 'https://login.beta.test/', 'idp|alpha-partner');
  ASSERT n = 0, 'A2 foreign issuer must not resolve';
  SELECT count(*) INTO n FROM platform.resolve_principal('beta-audit', 'https://login.alpha.test/', 'idp|alpha-partner');
  ASSERT n = 0, 'A2 subject from another tenant must not resolve';
  -- A3 Suspended users do not resolve.
  SELECT count(*) INTO n FROM platform.resolve_principal('alpha-audit', 'https://login.alpha.test/', 'idp|alpha-junior2');
  ASSERT n = 0, 'A3 suspended user must not resolve';
  -- A4 The lookup does not open app.users to the app role.
  SELECT count(*) INTO n FROM app.users;
  ASSERT n = 0, 'A4 users must stay invisible without a context';
END
$$;

-- A5 enter_context: verifies up front, refuses double entry.
SELECT set_config('app.ctx', '', false);
DO $$
DECLARE r record; tok text;
BEGIN
  PERFORM test.login('alpha', 'manager');
  tok := current_setting('app.ctx');
  PERFORM test.logout();
  SELECT * INTO r FROM app.enter_context(tok);
  ASSERT r.tenant_id = test.tenant('alpha') AND r.user_id = test.uid('alpha', 'manager'), 'A5 enter_context result';
  PERFORM test.expect_error(format('SELECT * FROM app.enter_context(%L)', tok), 'already present');
  PERFORM set_config('app.ctx', '', true);
  PERFORM test.expect_error(format('SELECT * FROM app.enter_context(%L)', replace(tok, 'v1.', 'v2.')), 'malformed');
END
$$;
ROLLBACK;
