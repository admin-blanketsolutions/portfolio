-- =============================================================================
-- Test fixtures (committed once per test database; each test file rolls back).
-- Two tenants, a small IFRS-style COA, one open engagement per tenant plus a
-- second "walled" engagement in tenant alpha that only its partner can see.
-- =============================================================================

-- Test-only signing key. Production keys come from the secrets manager.
INSERT INTO sec.context_signing_keys (key_id, secret, status)
VALUES ('test-k1', convert_to('test-only-hmac-key-0123456789abcdef-0123456789', 'UTF8'), 'active');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_app_it') THEN
    CREATE ROLE audit_app_it LOGIN PASSWORD 'it-only' IN ROLE audit_app;
  END IF;
END
$$;

CREATE SCHEMA test;
GRANT USAGE ON SCHEMA test TO audit_app;

CREATE FUNCTION test.tenant(p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT id FROM platform.tenants WHERE slug = p_slug || '-audit' $$;

CREATE FUNCTION test.uid(p_slug text, p_who text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM app.users WHERE tenant_id = test.tenant(p_slug) AND email = p_who || '@' || p_slug || '.test'
$$;

CREATE FUNCTION test.eng(p_slug text, p_code text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM app.engagements WHERE tenant_id = test.tenant(p_slug) AND code = p_code
$$;

CREATE FUNCTION test.coa(p_slug text, p_code text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM app.coa_accounts WHERE tenant_id = test.tenant(p_slug) AND code = p_code
$$;

-- "Log in": mint a signed ctx for the user (flags derived from the user row).
CREATE FUNCTION test.login(p_slug text, p_who text, p_ttl int DEFAULT 600) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ext, pg_temp AS $$
DECLARE u record; flags text := '';
BEGIN
  SELECT * INTO u FROM app.users WHERE tenant_id = test.tenant(p_slug) AND email = p_who || '@' || p_slug || '.test';
  IF NOT FOUND THEN RAISE EXCEPTION 'no user %/%', p_slug, p_who; END IF;
  IF u.is_firm_admin THEN flags := flags || 'A'; END IF;
  IF u.user_kind = 'service' THEN flags := flags || 'S'; END IF;
  IF u.user_kind = 'client_contact' THEN flags := flags || 'C'; END IF;
  PERFORM set_config('app.ctx', sec.mint_ctx(u.tenant_id, u.id, flags, p_ttl), false);
  RETURN p_slug || '/' || p_who;
END
$$;

CREATE FUNCTION test.logout() RETURNS void
LANGUAGE sql AS $$ SELECT set_config('app.ctx', '', false) $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA test TO audit_app;

-- Expect an error whose message matches p_pattern.
CREATE FUNCTION test.expect_error(p_sql text, p_pattern text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM !~* p_pattern THEN
      RAISE EXCEPTION 'expected error ~ "%", got "%" for: %', p_pattern, SQLERRM, p_sql;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected error ~ "%" but statement succeeded: %', p_pattern, p_sql;
END
$$;
GRANT EXECUTE ON FUNCTION test.expect_error(text, text) TO audit_app;

-- ---------------------------------------------------------------------------
-- Tenants, users, COA, clients, engagements
-- ---------------------------------------------------------------------------
SELECT platform.provision_tenant('alpha-audit', 'Alpha & Partners CPA', 'JO', 'me-central-1', 'cell-me-1',
                                 'arn:aws:kms:me-central-1:111111111111:key/alpha', 'idp|alpha-admin',
                                 'admin@alpha.test', 'Alpha Admin');
SELECT platform.provision_tenant('beta-audit', 'Beta Auditors LLC', 'AE', 'me-central-1', 'cell-me-1',
                                 'arn:aws:kms:me-central-1:111111111111:key/beta', 'idp|beta-admin',
                                 'admin@beta.test', 'Beta Admin');

DO $$
DECLARE s text; who text; spec text[];
BEGIN
  FOREACH s IN ARRAY ARRAY['alpha', 'beta'] LOOP
    PERFORM test.login(s, 'admin');
    UPDATE app.users SET mfa_enrolled = true, status = 'active' WHERE tenant_id = test.tenant(s);
    FOREACH who IN ARRAY ARRAY['partner:staff:partner', 'manager:staff:manager', 'senior:staff:senior',
                               'junior:staff:associate', 'junior2:staff:associate',
                               'client:client_contact:', 'svc:service:'] LOOP
      spec := string_to_array(who, ':');
      INSERT INTO app.users (tenant_id, idp_subject, email, display_name, user_kind, professional_rank,
                             mfa_enrolled, status)
      VALUES (test.tenant(s), 'idp|' || s || '-' || spec[1], spec[1] || '@' || s || '.test', initcap(spec[1]),
              spec[2]::app.user_kind, nullif(spec[3], '')::app.professional_rank, spec[2] <> 'service', 'active');
    END LOOP;

    INSERT INTO app.coa_accounts (tenant_id, code, path, name_en, name_ar, account_class, normal_balance,
                                  fs_statement, cash_flow_class, is_postable)
    SELECT test.tenant(s), c.code, c.path::ext.ltree, c.en, c.ar, c.cls::app.account_class, c.nb::app.balance_side,
           c.fs::app.fs_statement, c.cf::app.cash_flow_class, c.post
      FROM (VALUES
        ('BS',   'BS',                'Statement of financial position', 'قائمة المركز المالي', 'asset',     'debit',  'BS', 'non_cash',  false),
        ('BSA',  'BS.ASSETS',         'Assets',                          'الموجودات',           'asset',     'debit',  'BS', 'non_cash',  false),
        ('1000', 'BS.ASSETS.CASH',    'Cash and cash equivalents',       'النقد وما في حكمه',   'asset',     'debit',  'BS', 'cash',      true),
        ('1100', 'BS.ASSETS.AR',      'Trade receivables',               'ذمم مدينة تجارية',    'asset',     'debit',  'BS', 'operating', true),
        ('BSL',  'BS.LIAB',           'Liabilities',                     'المطلوبات',           'liability', 'credit', 'BS', 'non_cash',  false),
        ('2000', 'BS.LIAB.AP',        'Trade payables',                  'ذمم دائنة تجارية',    'liability', 'credit', 'BS', 'operating', true),
        ('BSE',  'BS.EQUITY',         'Equity',                          'حقوق الملكية',        'equity',    'credit', 'BS', 'non_cash',  false),
        ('3000', 'BS.EQUITY.CAPITAL', 'Share capital',                   'رأس المال',           'equity',    'credit', 'BS', 'financing', true),
        ('3100', 'BS.EQUITY.RE',      'Retained earnings',               'أرباح مدورة',         'equity',    'credit', 'BS', 'non_cash',  true),
        ('IS',   'IS',                'Statement of profit or loss',     'قائمة الدخل',         'revenue',   'credit', 'IS', 'non_cash',  false),
        ('4000', 'IS.REVENUE',        'Revenue',                         'الإيرادات',           'revenue',   'credit', 'IS', 'operating', true),
        ('ISX',  'IS.EXPENSES',       'Expenses',                        'المصاريف',            'expense',   'debit',  'IS', 'non_cash',  false),
        ('5000', 'IS.EXPENSES.COGS',  'Cost of sales',                   'تكلفة المبيعات',      'expense',   'debit',  'IS', 'operating', true),
        ('5100', 'IS.EXPENSES.ADMIN', 'Administrative expenses',         'مصاريف إدارية',       'expense',   'debit',  'IS', 'operating', true)
      ) AS c(code, path, en, ar, cls, nb, fs, cf, post);

    PERFORM test.login(s, 'manager');
    INSERT INTO app.clients (tenant_id, legal_name, legal_name_ar, registration_number, country_code,
                             functional_currency, fiscal_year_end_month)
    VALUES (test.tenant(s), initcap(s) || ' Client Co.', 'شركة العميل', 'REG-' || s, 'JO', 'JOD', 12);

    INSERT INTO app.engagements (tenant_id, client_id, code, period_start, period_end, reporting_currency,
                                 overall_materiality, performance_materiality, clearly_trivial_threshold)
    SELECT test.tenant(s), c.id, 'ENG-' || upper(left(s, 1)), DATE '2025-01-01', DATE '2025-12-31', 'JOD',
           50000, 37500, 2500
      FROM app.clients c WHERE c.tenant_id = test.tenant(s);

    -- Bootstrap: the creator (manager) adds themselves, then the team.
    INSERT INTO app.engagement_members (tenant_id, engagement_id, user_id, role)
    VALUES (test.tenant(s), test.eng(s, 'ENG-' || upper(left(s, 1))), test.uid(s, 'manager'), 'manager');
    INSERT INTO app.engagement_members (tenant_id, engagement_id, user_id, role)
    SELECT test.tenant(s), test.eng(s, 'ENG-' || upper(left(s, 1))), test.uid(s, m.who), m.role::app.engagement_role
      FROM (VALUES ('partner', 'engagement_partner'), ('senior', 'senior'), ('junior', 'associate'),
                   ('client', 'client_contact')) m(who, role);

    UPDATE app.engagements SET stage = 'fieldwork' WHERE tenant_id = test.tenant(s);
  END LOOP;

  -- A second alpha engagement staffed only by the partner (ethical-wall tests).
  PERFORM test.login('alpha', 'partner');
  INSERT INTO app.clients (tenant_id, legal_name, registration_number, country_code, functional_currency,
                           fiscal_year_end_month)
  VALUES (test.tenant('alpha'), 'Competitor Holding', 'REG-alpha-2', 'JO', 'JOD', 12);
  INSERT INTO app.engagements (tenant_id, client_id, code, period_start, period_end, reporting_currency)
  SELECT test.tenant('alpha'), id, 'ENG-WALL', DATE '2025-01-01', DATE '2025-12-31', 'JOD'
    FROM app.clients WHERE tenant_id = test.tenant('alpha') AND registration_number = 'REG-alpha-2';
  INSERT INTO app.engagement_members (tenant_id, engagement_id, user_id, role)
  VALUES (test.tenant('alpha'), test.eng('alpha', 'ENG-WALL'), test.uid('alpha', 'partner'), 'engagement_partner');

  PERFORM test.logout();
END
$$;
