-- =============================================================================
-- Demo firm for the hosted demo (SYNTHETIC DATA ONLY).
--
--   psql -v ON_ERROR_STOP=1 -v ctx_key_id=... -v ctx_key=... -v api_password=... \
--        -v issuer=https://login.<domain>/realms/jordan-audit -v web_client=audit-web \
--        -v llm_allowed=true -f demo.sql
--
-- Runs as a superuser, but every business row is written under a signed
-- tenant context, so row-level security, ethical walls, provenance triggers
-- and the audit chain apply exactly as they do for the API. Idempotent: it
-- does nothing if the demo firm already exists.
-- =============================================================================
\set ON_ERROR_STOP on
SELECT EXISTS (SELECT 1 FROM platform.tenants WHERE slug = 'jordan-audit') AS seeded \gset
\if :seeded
  \echo 'demo firm already present - nothing to do'
  \quit
\endif

INSERT INTO sec.context_signing_keys (key_id, secret, status)
VALUES (:'ctx_key_id', convert_to(:'ctx_key', 'UTF8'), 'active');

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_api') AS api_role \gset
\if :api_role
  ALTER ROLE audit_api PASSWORD :'api_password';
\else
  CREATE ROLE audit_api LOGIN PASSWORD :'api_password' IN ROLE audit_app;
\endif

SELECT set_config('demo.issuer', :'issuer', false) AS i, set_config('demo.web_client', :'web_client', false) AS w,
       set_config('demo.llm', :'llm_allowed', false) AS l \gset

BEGIN;
DO $$
DECLARE
  tid uuid;
  u record;
  login text;
BEGIN
  tid := platform.provision_tenant('jordan-audit', 'Jordan Audit & Assurance (Demo)', 'JO', 'me-central-1', 'cell-demo',
                                   'alias/audit-tenant-demo', 'demo|partner', 'rania.haddad@jordan-audit.example',
                                   'Rania Haddad');
  UPDATE platform.tenants SET oidc_issuer = current_setting('demo.issuer') WHERE id = tid;
  PERFORM platform.set_web_client(tid, current_setting('demo.web_client'));
  PERFORM platform.set_llm_mapping_allowed(tid, current_setting('demo.llm') = 'true');

  -- As the firm admin (the partner): activate, add the team, the chart and firm rules.
  SELECT id INTO u FROM app.users WHERE tenant_id = tid AND idp_subject = 'demo|partner';
  PERFORM set_config('app.ctx', sec.mint_ctx(tid, u.id, 'A', 600), false);
  UPDATE app.users SET mfa_enrolled = true, status = 'active', display_name_ar = 'رانيا حداد' WHERE tenant_id = tid;
  INSERT INTO app.users (tenant_id, idp_subject, email, display_name, display_name_ar, user_kind, professional_rank,
                         mfa_enrolled, status)
  VALUES (tid, 'demo|manager', 'omar.khalil@jordan-audit.example', 'Omar Khalil', 'عمر خليل', 'staff', 'manager', true, 'active'),
         (tid, 'demo|senior', 'sara.nasser@jordan-audit.example', 'Sara Nasser', 'سارة ناصر', 'staff', 'senior', true, 'active'),
         (tid, 'demo|junior', 'yousef.ali@jordan-audit.example', 'Yousef Ali', 'يوسف علي', 'staff', 'associate', true, 'active');

  INSERT INTO app.coa_accounts (tenant_id, code, path, name_en, name_ar, account_class, normal_balance,
                                fs_statement, cash_flow_class, is_postable, created_by)
  SELECT tid, c.code, c.path::ext.ltree, c.en, c.ar, c.cls::app.account_class, c.nb::app.balance_side,
         c.fs::app.fs_statement, c.cf::app.cash_flow_class, c.post, u.id
    FROM (VALUES
  ('BS', 'BS', 'Statement of financial position', 'قائمة المركز المالي', 'asset', 'debit', 'BS', 'non_cash', false),
  ('BS.A', 'BS.A', 'Assets', 'الموجودات', 'asset', 'debit', 'BS', 'non_cash', false),
  ('BS.A.NCA', 'BS.A.NCA', 'Non-current assets', 'الموجودات غير المتداولة', 'asset', 'debit', 'BS', 'non_cash', false),
  ('BS.A.NCA.PPE', 'BS.A.NCA.PPE', 'Property and equipment', 'الممتلكات والمعدات', 'asset', 'debit', 'BS', 'non_cash', false),
  ('BS.A.NCA.INT', 'BS.A.NCA.INT', 'Intangible assets', 'الموجودات غير الملموسة', 'asset', 'debit', 'BS', 'non_cash', false),
  ('BS.A.NCA.ROU', 'BS.A.NCA.ROU', 'Right-of-use assets', 'موجودات حق الاستخدام', 'asset', 'debit', 'BS', 'non_cash', false),
  ('BS.A.NCA.IP', 'BS.A.NCA.IP', 'Investment property', 'الاستثمارات العقارية', 'asset', 'debit', 'BS', 'non_cash', false),
  ('BS.A.NCA.FIN', 'BS.A.NCA.FIN', 'Financial assets', 'الموجودات المالية', 'asset', 'debit', 'BS', 'non_cash', false),
  ('BS.A.CA', 'BS.A.CA', 'Current assets', 'الموجودات المتداولة', 'asset', 'debit', 'BS', 'non_cash', false),
  ('BS.A.CA.INV', 'BS.A.CA.INV', 'Inventories', 'المخزون', 'asset', 'debit', 'BS', 'non_cash', false),
  ('BS.A.CA.REC', 'BS.A.CA.REC', 'Trade and other receivables', 'الذمم المدينة والأخرى', 'asset', 'debit', 'BS', 'non_cash', false),
  ('BS.A.CA.PRE', 'BS.A.CA.PRE', 'Prepayments and other current assets', 'المصاريف المدفوعة مقدماً والأرصدة المدينة الأخرى', 'asset', 'debit', 'BS', 'non_cash', false),
  ('BS.A.CA.CASH', 'BS.A.CA.CASH', 'Cash and cash equivalents', 'النقد وما في حكمه', 'asset', 'debit', 'BS', 'non_cash', false),
  ('BS.L', 'BS.L', 'Liabilities', 'المطلوبات', 'liability', 'credit', 'BS', 'non_cash', false),
  ('BS.L.NCL', 'BS.L.NCL', 'Non-current liabilities', 'المطلوبات غير المتداولة', 'liability', 'credit', 'BS', 'non_cash', false),
  ('BS.L.CL', 'BS.L.CL', 'Current liabilities', 'المطلوبات المتداولة', 'liability', 'credit', 'BS', 'non_cash', false),
  ('BS.L.CL.PAY', 'BS.L.CL.PAY', 'Trade and other payables', 'الذمم الدائنة والأرصدة الدائنة الأخرى', 'liability', 'credit', 'BS', 'non_cash', false),
  ('BS.L.CL.TAX', 'BS.L.CL.TAX', 'Tax and social security', 'الضرائب والضمان الاجتماعي', 'liability', 'credit', 'BS', 'non_cash', false),
  ('BS.L.CL.BOR', 'BS.L.CL.BOR', 'Short-term borrowings', 'القروض قصيرة الأجل', 'liability', 'credit', 'BS', 'non_cash', false),
  ('BS.E', 'BS.E', 'Equity', 'حقوق الملكية', 'equity', 'credit', 'BS', 'non_cash', false),
  ('IS', 'IS', 'Statement of profit or loss', 'قائمة الأرباح أو الخسائر', 'revenue', 'credit', 'IS', 'non_cash', false),
  ('IS.REV', 'IS.REV', 'Revenue', 'الإيرادات', 'revenue', 'credit', 'IS', 'non_cash', false),
  ('IS.COS', 'IS.COS', 'Cost of sales', 'تكلفة المبيعات', 'expense', 'debit', 'IS', 'non_cash', false),
  ('IS.OI', 'IS.OI', 'Other income', 'إيرادات أخرى', 'revenue', 'credit', 'IS', 'non_cash', false),
  ('IS.OPEX', 'IS.OPEX', 'Operating expenses', 'المصاريف التشغيلية', 'expense', 'debit', 'IS', 'non_cash', false),
  ('IS.OPEX.STAFF', 'IS.OPEX.STAFF', 'Staff costs', 'تكاليف الموظفين', 'expense', 'debit', 'IS', 'non_cash', false),
  ('IS.OPEX.ADMIN', 'IS.OPEX.ADMIN', 'General and administrative expenses', 'المصاريف العمومية والإدارية', 'expense', 'debit', 'IS', 'non_cash', false),
  ('IS.OPEX.DA', 'IS.OPEX.DA', 'Depreciation and amortisation', 'الاستهلاك والإطفاء', 'expense', 'debit', 'IS', 'non_cash', false),
  ('IS.OPEX.ECL', 'IS.OPEX.ECL', 'Impairment of receivables', 'انخفاض قيمة الذمم المدينة', 'expense', 'debit', 'IS', 'non_cash', false),
  ('IS.FIN', 'IS.FIN', 'Finance costs and exchange differences', 'تكاليف التمويل وفروقات العملة', 'expense', 'debit', 'IS', 'non_cash', false),
  ('IS.TAX', 'IS.TAX', 'Income tax', 'ضريبة الدخل', 'expense', 'debit', 'IS', 'non_cash', false),
  ('1000', 'BS.A.CA.CASH.A1000', 'Cash on hand', 'النقد في الصندوق', 'asset', 'debit', 'BS', 'cash', true),
  ('1010', 'BS.A.CA.CASH.A1010', 'Cash at banks - current accounts', 'النقد لدى البنوك - حسابات جارية', 'asset', 'debit', 'BS', 'cash', true),
  ('1020', 'BS.A.CA.CASH.A1020', 'Short-term bank deposits', 'ودائع بنكية قصيرة الأجل', 'asset', 'debit', 'BS', 'cash', true),
  ('1030', 'BS.A.CA.CASH.A1030', 'Cheques under collection', 'شيكات برسم التحصيل', 'asset', 'debit', 'BS', 'cash', true),
  ('1100', 'BS.A.CA.REC.A1100', 'Trade receivables', 'ذمم مدينة تجارية', 'asset', 'debit', 'BS', 'operating', true),
  ('1105', 'BS.A.CA.REC.A1105', 'Allowance for expected credit losses', 'مخصص الخسائر الائتمانية المتوقعة', 'asset', 'credit', 'BS', 'operating', true),
  ('1110', 'BS.A.CA.REC.A1110', 'Post-dated cheques receivable', 'شيكات مؤجلة القبض', 'asset', 'debit', 'BS', 'operating', true),
  ('1120', 'BS.A.CA.REC.A1120', 'Due from related parties', 'مطلوب من جهات ذات علاقة', 'asset', 'debit', 'BS', 'operating', true),
  ('1130', 'BS.A.CA.REC.A1130', 'Employee receivables and advances', 'ذمم وسلف الموظفين', 'asset', 'debit', 'BS', 'operating', true),
  ('1140', 'BS.A.CA.PRE.A1140', 'Prepaid expenses', 'مصاريف مدفوعة مقدماً', 'asset', 'debit', 'BS', 'operating', true),
  ('1150', 'BS.A.CA.PRE.A1150', 'Refundable deposits', 'تأمينات مستردة', 'asset', 'debit', 'BS', 'operating', true),
  ('1160', 'BS.A.CA.PRE.A1160', 'Advances to suppliers', 'دفعات مقدمة للموردين', 'asset', 'debit', 'BS', 'operating', true),
  ('1170', 'BS.A.CA.PRE.A1170', 'Sales tax recoverable (input tax)', 'ضريبة المبيعات المستردة (مدخلات)', 'asset', 'debit', 'BS', 'operating', true),
  ('1180', 'BS.A.CA.REC.A1180', 'Other receivables', 'ذمم مدينة أخرى', 'asset', 'debit', 'BS', 'operating', true),
  ('1200', 'BS.A.CA.INV.A1200', 'Inventory - raw materials', 'مخزون مواد خام', 'asset', 'debit', 'BS', 'operating', true),
  ('1210', 'BS.A.CA.INV.A1210', 'Inventory - finished goods', 'مخزون بضاعة جاهزة', 'asset', 'debit', 'BS', 'operating', true),
  ('1220', 'BS.A.CA.INV.A1220', 'Inventory - goods for resale', 'مخزون بضاعة بغرض البيع', 'asset', 'debit', 'BS', 'operating', true),
  ('1230', 'BS.A.CA.INV.A1230', 'Goods in transit', 'بضاعة في الطريق', 'asset', 'debit', 'BS', 'operating', true),
  ('1300', 'BS.A.NCA.PPE.A1300', 'Land', 'أراضي', 'asset', 'debit', 'BS', 'investing', true),
  ('1310', 'BS.A.NCA.PPE.A1310', 'Buildings', 'مباني', 'asset', 'debit', 'BS', 'investing', true),
  ('1320', 'BS.A.NCA.PPE.A1320', 'Machinery and equipment', 'آلات ومعدات', 'asset', 'debit', 'BS', 'investing', true),
  ('1330', 'BS.A.NCA.PPE.A1330', 'Vehicles', 'وسائط نقل', 'asset', 'debit', 'BS', 'investing', true),
  ('1340', 'BS.A.NCA.PPE.A1340', 'Furniture and fixtures', 'أثاث وتجهيزات', 'asset', 'debit', 'BS', 'investing', true),
  ('1350', 'BS.A.NCA.PPE.A1350', 'Computers and IT equipment', 'أجهزة حاسوب', 'asset', 'debit', 'BS', 'investing', true),
  ('1360', 'BS.A.NCA.PPE.A1360', 'Accumulated depreciation - property and equipment', 'مجمع استهلاك الممتلكات والمعدات', 'asset', 'credit', 'BS', 'investing', true),
  ('1370', 'BS.A.NCA.PPE.A1370', 'Projects under construction', 'مشاريع تحت التنفيذ', 'asset', 'debit', 'BS', 'investing', true),
  ('1400', 'BS.A.NCA.INT.A1400', 'Intangible assets - software', 'موجودات غير ملموسة - برامج', 'asset', 'debit', 'BS', 'investing', true),
  ('1410', 'BS.A.NCA.ROU.A1410', 'Right-of-use assets', 'موجودات حق الاستخدام', 'asset', 'debit', 'BS', 'non_cash', true),
  ('1420', 'BS.A.NCA.IP.A1420', 'Investment property', 'استثمارات عقارية', 'asset', 'debit', 'BS', 'investing', true),
  ('1430', 'BS.A.NCA.FIN.A1430', 'Financial assets at fair value through OCI', 'موجودات مالية بالقيمة العادلة من خلال الدخل الشامل الآخر', 'asset', 'debit', 'BS', 'investing', true),
  ('2000', 'BS.L.CL.PAY.A2000', 'Trade payables', 'ذمم دائنة تجارية', 'liability', 'credit', 'BS', 'operating', true),
  ('2010', 'BS.L.CL.PAY.A2010', 'Accrued expenses', 'مصاريف مستحقة', 'liability', 'credit', 'BS', 'operating', true),
  ('2020', 'BS.L.CL.PAY.A2020', 'Contract liabilities (customer advances)', 'دفعات مقدمة من العملاء', 'liability', 'credit', 'BS', 'operating', true),
  ('2030', 'BS.L.CL.PAY.A2030', 'Due to related parties', 'مطلوب لجهات ذات علاقة', 'liability', 'credit', 'BS', 'operating', true),
  ('2040', 'BS.L.CL.PAY.A2040', 'Post-dated cheques payable', 'شيكات آجلة الدفع', 'liability', 'credit', 'BS', 'operating', true),
  ('2050', 'BS.L.CL.TAX.A2050', 'Income tax payable', 'مخصص ضريبة الدخل', 'liability', 'credit', 'BS', 'operating', true),
  ('2060', 'BS.L.CL.TAX.A2060', 'Sales tax payable (output tax)', 'ضريبة المبيعات المستحقة', 'liability', 'credit', 'BS', 'operating', true),
  ('2070', 'BS.L.CL.TAX.A2070', 'Social security payable', 'اشتراكات الضمان الاجتماعي المستحقة', 'liability', 'credit', 'BS', 'operating', true),
  ('2080', 'BS.L.NCL.A2080', 'Provision for end-of-service indemnity', 'مخصص مكافأة نهاية الخدمة', 'liability', 'credit', 'BS', 'operating', true),
  ('2090', 'BS.L.CL.PAY.A2090', 'Other payables', 'ذمم دائنة أخرى', 'liability', 'credit', 'BS', 'operating', true),
  ('2100', 'BS.L.CL.BOR.A2100', 'Bank overdrafts', 'بنوك دائنة', 'liability', 'credit', 'BS', 'financing', true),
  ('2110', 'BS.L.CL.BOR.A2110', 'Short-term loans', 'قروض قصيرة الأجل', 'liability', 'credit', 'BS', 'financing', true),
  ('2120', 'BS.L.NCL.A2120', 'Long-term loans', 'قروض طويلة الأجل', 'liability', 'credit', 'BS', 'financing', true),
  ('2130', 'BS.L.NCL.A2130', 'Lease liabilities', 'التزامات عقود الإيجار', 'liability', 'credit', 'BS', 'financing', true),
  ('2140', 'BS.L.CL.PAY.A2140', 'Dividends payable', 'أرباح موزعة مستحقة الدفع', 'liability', 'credit', 'BS', 'financing', true),
  ('2150', 'BS.L.CL.PAY.A2150', 'Deposits received (guarantees)', 'أمانات وتأمينات مستلمة', 'liability', 'credit', 'BS', 'operating', true),
  ('3000', 'BS.E.A3000', 'Share capital', 'رأس المال المدفوع', 'equity', 'credit', 'BS', 'financing', true),
  ('3010', 'BS.E.A3010', 'Statutory reserve', 'احتياطي إجباري', 'equity', 'credit', 'BS', 'non_cash', true),
  ('3020', 'BS.E.A3020', 'Voluntary reserve', 'احتياطي اختياري', 'equity', 'credit', 'BS', 'non_cash', true),
  ('3030', 'BS.E.A3030', 'Retained earnings', 'أرباح مدورة', 'equity', 'credit', 'BS', 'non_cash', true),
  ('3040', 'BS.E.A3040', 'Partners'' current accounts', 'جاري الشركاء', 'equity', 'credit', 'BS', 'non_cash', true),
  ('3050', 'BS.E.A3050', 'Fair value reserve', 'احتياطي القيمة العادلة', 'equity', 'credit', 'BS', 'non_cash', true),
  ('4000', 'IS.REV.A4000', 'Revenue from sale of goods', 'إيرادات المبيعات', 'revenue', 'credit', 'IS', 'operating', true),
  ('4010', 'IS.REV.A4010', 'Revenue from services', 'إيرادات الخدمات', 'revenue', 'credit', 'IS', 'operating', true),
  ('4020', 'IS.REV.A4020', 'Sales returns and allowances', 'مردودات ومسموحات المبيعات', 'revenue', 'debit', 'IS', 'operating', true),
  ('4030', 'IS.REV.A4030', 'Sales discounts', 'خصم مسموح به', 'revenue', 'debit', 'IS', 'operating', true),
  ('4100', 'IS.OI.A4100', 'Interest income', 'إيرادات فوائد بنكية', 'revenue', 'credit', 'IS', 'operating', true),
  ('4110', 'IS.OI.A4110', 'Rental income', 'إيرادات إيجارات', 'revenue', 'credit', 'IS', 'operating', true),
  ('4120', 'IS.OI.A4120', 'Gain on disposal of property and equipment', 'أرباح بيع ممتلكات ومعدات', 'revenue', 'credit', 'IS', 'operating', true),
  ('4130', 'IS.OI.A4130', 'Other income', 'إيرادات أخرى', 'revenue', 'credit', 'IS', 'operating', true),
  ('5000', 'IS.COS.A5000', 'Cost of goods sold', 'تكلفة البضاعة المباعة', 'expense', 'debit', 'IS', 'operating', true),
  ('5010', 'IS.COS.A5010', 'Purchases', 'مشتريات', 'expense', 'debit', 'IS', 'operating', true),
  ('5020', 'IS.COS.A5020', 'Purchase returns', 'مردودات المشتريات', 'expense', 'credit', 'IS', 'operating', true),
  ('5100', 'IS.OPEX.STAFF.A5100', 'Salaries and wages', 'رواتب وأجور', 'expense', 'debit', 'IS', 'operating', true),
  ('5110', 'IS.OPEX.STAFF.A5110', 'Social security contribution - employer', 'مساهمة الشركة في الضمان الاجتماعي', 'expense', 'debit', 'IS', 'operating', true),
  ('5120', 'IS.OPEX.STAFF.A5120', 'Employee benefits (health insurance)', 'منافع الموظفين (تأمين صحي)', 'expense', 'debit', 'IS', 'operating', true),
  ('5130', 'IS.OPEX.STAFF.A5130', 'End-of-service indemnity expense', 'مصروف مكافأة نهاية الخدمة', 'expense', 'debit', 'IS', 'operating', true),
  ('5200', 'IS.OPEX.ADMIN.A5200', 'Rent expense', 'إيجارات', 'expense', 'debit', 'IS', 'operating', true),
  ('5210', 'IS.OPEX.ADMIN.A5210', 'Utilities (electricity and water)', 'كهرباء ومياه', 'expense', 'debit', 'IS', 'operating', true),
  ('5220', 'IS.OPEX.ADMIN.A5220', 'Telecommunications and internet', 'اتصالات وإنترنت', 'expense', 'debit', 'IS', 'operating', true),
  ('5230', 'IS.OPEX.ADMIN.A5230', 'Repairs and maintenance', 'صيانة وإصلاحات', 'expense', 'debit', 'IS', 'operating', true),
  ('5240', 'IS.OPEX.ADMIN.A5240', 'Fuel and vehicle expenses', 'محروقات ومصاريف سيارات', 'expense', 'debit', 'IS', 'operating', true),
  ('5250', 'IS.OPEX.ADMIN.A5250', 'Stationery and printing', 'قرطاسية ومطبوعات', 'expense', 'debit', 'IS', 'operating', true),
  ('5260', 'IS.OPEX.ADMIN.A5260', 'Professional and legal fees', 'أتعاب مهنية وقانونية', 'expense', 'debit', 'IS', 'operating', true),
  ('5270', 'IS.OPEX.ADMIN.A5270', 'Advertising and marketing', 'دعاية وإعلان', 'expense', 'debit', 'IS', 'operating', true),
  ('5280', 'IS.OPEX.ADMIN.A5280', 'Travel and transportation', 'سفر وتنقلات', 'expense', 'debit', 'IS', 'operating', true),
  ('5290', 'IS.OPEX.ADMIN.A5290', 'Government fees and licences', 'رسوم ورخص حكومية', 'expense', 'debit', 'IS', 'operating', true),
  ('5300', 'IS.OPEX.ADMIN.A5300', 'Insurance expense', 'مصروف تأمين', 'expense', 'debit', 'IS', 'operating', true),
  ('5310', 'IS.OPEX.ADMIN.A5310', 'Bank charges and commissions', 'عمولات ومصاريف بنكية', 'expense', 'debit', 'IS', 'operating', true),
  ('5320', 'IS.OPEX.ADMIN.A5320', 'Hospitality and cleaning', 'ضيافة ونظافة', 'expense', 'debit', 'IS', 'operating', true),
  ('5330', 'IS.OPEX.ADMIN.A5330', 'Donations', 'تبرعات', 'expense', 'debit', 'IS', 'operating', true),
  ('5400', 'IS.OPEX.DA.A5400', 'Depreciation expense', 'مصروف الاستهلاك', 'expense', 'debit', 'IS', 'non_cash', true),
  ('5410', 'IS.OPEX.DA.A5410', 'Amortisation expense', 'مصروف الإطفاء', 'expense', 'debit', 'IS', 'non_cash', true),
  ('5420', 'IS.OPEX.ECL.A5420', 'Expected credit loss expense', 'مصروف الخسائر الائتمانية المتوقعة', 'expense', 'debit', 'IS', 'non_cash', true),
  ('5500', 'IS.FIN.A5500', 'Finance costs', 'تكاليف تمويل', 'expense', 'debit', 'IS', 'operating', true),
  ('5510', 'IS.FIN.A5510', 'Foreign exchange differences', 'فروقات عملة', 'expense', 'debit', 'IS', 'operating', true),
  ('5600', 'IS.TAX.A5600', 'Income tax expense', 'مصروف ضريبة الدخل', 'expense', 'debit', 'IS', 'operating', true)
    ) AS c(code, path, en, ar, cls, nb, fs, cf, post);

  INSERT INTO app.mapping_rules (tenant_id, priority, kind, pattern, coa_account_id, description, created_by)
  SELECT tid, r.prio, r.kind::app.mapping_rule_kind, r.pattern, a.id, r.descr, u.id
    FROM (VALUES
      (10, 'name_contains', 'petty cash', '1000', 'Petty cash is always cash on hand'),
      (11, 'name_contains', 'نثرية', '1000', 'النثرية تصنف ضمن النقد في الصندوق'),
      (20, 'name_contains', 'bank charges', '5310', 'Bank charges and commissions'),
      (21, 'name_contains', 'عمولات بنكية', '5310', 'العمولات البنكية')
    ) AS r(prio, kind, pattern, code, descr)
    JOIN app.coa_accounts a ON a.tenant_id = tid AND a.code = r.code;

  -- As the manager: clients, FY2025 engagements, and the team on each.
  SELECT id INTO u FROM app.users WHERE tenant_id = tid AND idp_subject = 'demo|manager';
  PERFORM set_config('app.ctx', sec.mint_ctx(tid, u.id, '', 600), false);
  INSERT INTO app.clients (tenant_id, legal_name, legal_name_ar, registration_number, country_code,
                           functional_currency, fiscal_year_end_month, created_by)
  VALUES (tid, 'Al-Nakheel Trading Co.', 'شركة النخيل التجارية', 'CCD-41277', 'JO', 'JOD', 12, u.id),
         (tid, 'Petra Food Industries', 'شركة البتراء للصناعات الغذائية', 'CCD-18830', 'JO', 'JOD', 12, u.id),
         (tid, 'Zahran Real Estate Investments', 'شركة زهران للاستثمارات العقارية', 'CCD-52019', 'JO', 'JOD', 12, u.id);
  INSERT INTO app.engagements (tenant_id, client_id, code, period_start, period_end, reporting_currency,
                               overall_materiality, performance_materiality, clearly_trivial_threshold, created_by)
  SELECT tid, c.id, e.code, DATE '2025-01-01', DATE '2025-12-31', 'JOD', e.om, e.pm, e.ct, u.id
    FROM (VALUES ('CCD-41277', 'NKH-FY2025', 60000, 45000, 3000),
                 ('CCD-18830', 'PETRA-FY2025', 120000, 90000, 6000),
                 ('CCD-52019', 'ZHR-FY2025', 250000, 187500, 12500)) AS e(reg, code, om, pm, ct)
    JOIN app.clients c ON c.tenant_id = tid AND c.registration_number = e.reg;
  INSERT INTO app.engagement_members (tenant_id, engagement_id, user_id, role)
  SELECT tid, e.id, u.id, 'manager' FROM app.engagements e WHERE e.tenant_id = tid;
  INSERT INTO app.engagement_members (tenant_id, engagement_id, user_id, role)
  SELECT tid, e.id, m.id, r.role::app.engagement_role
    FROM app.engagements e
    CROSS JOIN (VALUES ('demo|partner', 'engagement_partner'), ('demo|senior', 'senior'), ('demo|junior', 'associate')) AS r(sub, role)
    JOIN app.users m ON m.tenant_id = tid AND m.idp_subject = r.sub
   WHERE e.tenant_id = tid;
  UPDATE app.engagements SET stage = 'fieldwork' WHERE tenant_id = tid;

  PERFORM set_config('app.ctx', '', false);
END
$$;
COMMIT;
\echo 'demo firm "jordan-audit" created'
