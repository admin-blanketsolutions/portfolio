-- =============================================================================
-- V0003 — Core relational schema
-- -----------------------------------------------------------------------------
-- Design invariants (verified by db/tests/10_schema_lint.sql):
--
--  I1  Every tenant-owned table has `tenant_id uuid NOT NULL` as the FIRST
--      column of its primary key: PK = (tenant_id, id).
--  I2  Every foreign key between tenant-owned tables is COMPOSITE and includes
--      tenant_id: (tenant_id, x_id) -> parent(tenant_id, id). A buggy or
--      malicious write can therefore never link a row to another tenant's
--      parent, and FK errors cannot be used as a cross-tenant existence oracle.
--  I3  Denormalised columns (e.g. engagement_id on child rows, kept for RLS and
--      roll-up locality) are pinned by a composite FK to the parent's
--      (tenant_id, id, engagement_id) so they cannot drift.
--  I4  Every UNIQUE constraint on tenant data includes tenant_id (no global
--      uniqueness oracles such as "this e-mail exists somewhere").
--  I5  Money is NUMERIC, never float. Scale 4 covers 3-decimal MENA currencies
--      (JOD, KWD, BHD, OMR, IQD, LYD, TND) with a guard digit.
--  I6  Server-authoritative time: created_at / signed_at / posted_at are set by
--      triggers from clock_timestamp(); client-supplied values are overwritten.
-- =============================================================================
SET ROLE audit_owner;

-- ---------------------------------------------------------------------------
-- Domains & enumerations
-- ---------------------------------------------------------------------------
CREATE DOMAIN app.money         AS numeric(24, 4);
CREATE DOMAIN app.currency_code AS char(3)  CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN app.country_code  AS char(2)  CHECK (VALUE ~ '^[A-Z]{2}$');
CREATE DOMAIN app.sha256        AS bytea    CHECK (octet_length(VALUE) = 32);

CREATE TYPE platform.isolation_tier AS ENUM ('pooled', 'silo');
CREATE TYPE platform.tenant_status  AS ENUM ('provisioning', 'active', 'suspended', 'offboarding', 'closed');

CREATE TYPE app.user_kind        AS ENUM ('staff', 'client_contact', 'service');
CREATE TYPE app.user_status      AS ENUM ('invited', 'active', 'suspended', 'deprovisioned');
CREATE TYPE app.professional_rank AS ENUM ('associate', 'senior', 'manager', 'director', 'partner');
CREATE TYPE app.engagement_type  AS ENUM ('statutory_audit', 'review', 'agreed_upon_procedures', 'compilation');
CREATE TYPE app.reporting_framework AS ENUM ('IFRS', 'IFRS_FOR_SMES', 'LOCAL_GAAP');
CREATE TYPE app.engagement_stage AS ENUM ('planning', 'fieldwork', 'review', 'reporting', 'completed', 'archived');
CREATE TYPE app.engagement_role  AS ENUM ('associate', 'senior', 'manager', 'engagement_partner', 'eqr_reviewer', 'client_contact');
CREATE TYPE app.account_class    AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
CREATE TYPE app.balance_side     AS ENUM ('debit', 'credit');
CREATE TYPE app.fs_statement     AS ENUM ('BS', 'IS', 'OCI', 'SOCE');
CREATE TYPE app.cash_flow_class  AS ENUM ('cash', 'operating', 'investing', 'financing', 'non_cash');
CREATE TYPE app.tb_kind          AS ENUM ('current_unadjusted', 'prior_year_final');
CREATE TYPE app.tb_status        AS ENUM ('importing', 'imported', 'locked', 'superseded');
CREATE TYPE app.mapping_source   AS ENUM ('rule', 'exact', 'fuzzy', 'embedding', 'llm', 'manual', 'carried_forward');
CREATE TYPE app.mapping_status   AS ENUM ('suggested', 'accepted', 'rejected', 'superseded');
CREATE TYPE app.aje_type         AS ENUM ('AJE', 'RJE', 'PAJE');  -- adjusting, reclassification, passed (ISA 450)
CREATE TYPE app.aje_status       AS ENUM ('draft', 'proposed', 'approved', 'posted', 'rejected');
CREATE TYPE app.workpaper_status AS ENUM ('draft', 'prepared', 'reviewed', 'approved');
CREATE TYPE app.signoff_level    AS ENUM ('preparer', 'reviewer', 'partner');
CREATE TYPE app.scan_status      AS ENUM ('pending', 'clean', 'infected', 'rejected');

-- ---------------------------------------------------------------------------
-- Control plane: tenants (an audit firm = a tenant)
-- ---------------------------------------------------------------------------
CREATE TABLE platform.tenants (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                    text        NOT NULL UNIQUE
                                      CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  legal_name              text        NOT NULL CHECK (length(legal_name) BETWEEN 2 AND 300),
  legal_name_ar           text,
  country_code            app.country_code NOT NULL,
  home_region             text        NOT NULL,   -- e.g. 'me-central-1', 'jo-sovereign-1'
  deployment_cell         text        NOT NULL,   -- cell / cluster that serves this tenant
  isolation_tier          platform.isolation_tier NOT NULL DEFAULT 'pooled',
  kms_key_ref             text        NOT NULL,   -- per-tenant CMK ARN or XKS key id
  status                  platform.tenant_status NOT NULL DEFAULT 'provisioning',
  record_retention_years  smallint    NOT NULL DEFAULT 10 CHECK (record_retention_years BETWEEN 5 AND 30),
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- ---------------------------------------------------------------------------
-- Users (tenant-scoped identities; a person in two firms = two rows)
-- ---------------------------------------------------------------------------
CREATE TABLE app.users (
  tenant_id        uuid        NOT NULL REFERENCES platform.tenants (id),
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  idp_subject      text        NOT NULL,            -- OIDC `sub` from the firm's IdP
  email            text        NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name     text        NOT NULL,
  display_name_ar  text,
  user_kind        app.user_kind NOT NULL,
  professional_rank app.professional_rank,          -- staff only
  is_firm_admin    boolean     NOT NULL DEFAULT false,
  mfa_enrolled     boolean     NOT NULL DEFAULT false,
  status           app.user_status NOT NULL DEFAULT 'invited',
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idp_subject),
  CHECK ((user_kind = 'staff') = (professional_rank IS NOT NULL)),
  CHECK (NOT is_firm_admin OR user_kind = 'staff'),
  CHECK (status <> 'active' OR user_kind = 'service' OR mfa_enrolled)   -- no active human without MFA
);
CREATE UNIQUE INDEX users_tenant_email_uq ON app.users (tenant_id, lower(email));

-- ---------------------------------------------------------------------------
-- Clients (audited entities)
-- ---------------------------------------------------------------------------
CREATE TABLE app.clients (
  tenant_id              uuid        NOT NULL REFERENCES platform.tenants (id),
  id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
  legal_name             text        NOT NULL,
  legal_name_ar          text,
  registration_number    text        NOT NULL,       -- e.g. Companies Control Dept. no.
  country_code           app.country_code NOT NULL,
  functional_currency    app.currency_code NOT NULL,
  fiscal_year_end_month  smallint    NOT NULL CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
  is_public_interest_entity boolean  NOT NULL DEFAULT false,   -- drives mandatory EQR (ISQM 2)
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by             uuid        NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, country_code, registration_number),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.users (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Engagements
-- ---------------------------------------------------------------------------
CREATE TABLE app.engagements (
  tenant_id                 uuid        NOT NULL,
  id                        uuid        NOT NULL DEFAULT gen_random_uuid(),
  client_id                 uuid        NOT NULL,
  code                      text        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'),
  engagement_type           app.engagement_type NOT NULL DEFAULT 'statutory_audit',
  reporting_framework       app.reporting_framework NOT NULL DEFAULT 'IFRS',
  period_start              date        NOT NULL,
  period_end                date        NOT NULL,
  reporting_currency        app.currency_code NOT NULL,
  stage                     app.engagement_stage NOT NULL DEFAULT 'planning',
  overall_materiality       app.money   CHECK (overall_materiality > 0),
  performance_materiality   app.money   CHECK (performance_materiality > 0),
  clearly_trivial_threshold app.money   CHECK (clearly_trivial_threshold >= 0),
  report_date               date,
  -- ISA 230.A21: final file assembly normally within 60 days of the report date.
  assembly_deadline         date GENERATED ALWAYS AS (report_date + 60) STORED,
  archived_at               timestamptz,
  aje_seq                   integer     NOT NULL DEFAULT 0 CHECK (aje_seq >= 0),  -- gapless AJE numbering
  created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by                uuid        NOT NULL,
  updated_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, client_id)  REFERENCES app.clients (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.users (tenant_id, id),
  CHECK (period_end > period_start),
  CHECK (period_end - period_start <= 550),                 -- first periods up to ~18 months
  CHECK (report_date IS NULL OR report_date > period_end),
  CHECK (performance_materiality IS NULL OR overall_materiality IS NULL
         OR performance_materiality <= overall_materiality),
  CHECK (clearly_trivial_threshold IS NULL OR performance_materiality IS NULL
         OR clearly_trivial_threshold <= performance_materiality),
  CHECK ((stage = 'archived') = (archived_at IS NOT NULL))
);
CREATE INDEX engagements_client_period_ix ON app.engagements (tenant_id, client_id, period_end DESC);
CREATE INDEX engagements_open_stage_ix    ON app.engagements (tenant_id, stage) WHERE stage <> 'archived';

CREATE TABLE app.engagement_members (
  tenant_id      uuid        NOT NULL,
  engagement_id  uuid        NOT NULL,
  user_id        uuid        NOT NULL,
  role           app.engagement_role NOT NULL,
  independence_confirmed_at timestamptz,               -- IESBA / ISA 220 independence
  removed_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by     uuid        NOT NULL,
  PRIMARY KEY (tenant_id, engagement_id, user_id),
  FOREIGN KEY (tenant_id, engagement_id) REFERENCES app.engagements (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id)       REFERENCES app.users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)    REFERENCES app.users (tenant_id, id)
);
-- Drives the ethical-wall RLS predicate: "is the current user an active member?"
CREATE INDEX engagement_members_user_ix ON app.engagement_members (tenant_id, user_id, engagement_id)
  WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Standard chart of accounts (firm-level, hierarchical via ltree)
--   path examples:  BS.ASSETS.CURRENT.CASH   IS.REVENUE.SALES
-- ---------------------------------------------------------------------------
CREATE TABLE app.coa_accounts (
  tenant_id          uuid        NOT NULL REFERENCES platform.tenants (id),
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  code               text        NOT NULL CHECK (code ~ '^[0-9A-Z.-]{1,20}$'),
  path               ext.ltree   NOT NULL,
  name_en            text        NOT NULL,
  name_ar            text        NOT NULL,
  account_class      app.account_class NOT NULL,
  normal_balance     app.balance_side  NOT NULL,
  fs_statement       app.fs_statement  NOT NULL,
  cash_flow_class    app.cash_flow_class NOT NULL,
  is_postable        boolean     NOT NULL DEFAULT true,   -- leaves only; headers roll up
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by         uuid        NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, path),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.users (tenant_id, id)
);
CREATE INDEX coa_accounts_path_gist ON app.coa_accounts USING gist (path);

-- ---------------------------------------------------------------------------
-- Trial balances (versioned imports) and lines (hash-partitioned by tenant)
-- ---------------------------------------------------------------------------
CREATE TABLE app.trial_balances (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  engagement_id    uuid        NOT NULL,
  tb_kind          app.tb_kind NOT NULL DEFAULT 'current_unadjusted',
  version          integer     NOT NULL CHECK (version > 0),
  as_of_date       date        NOT NULL,
  currency         app.currency_code NOT NULL,
  status           app.tb_status NOT NULL DEFAULT 'importing',
  -- Provenance of the ingested file (object is in S3 with Object Lock):
  source_object_key text       NOT NULL,
  source_sha256    app.sha256  NOT NULL,
  source_filename  text        NOT NULL,
  parser_version   text        NOT NULL,
  -- Control totals reported by the sandboxed parser, re-verified in-DB when
  -- the import is closed: line count, sum of debit (positive) closing
  -- balances and sum of credit (negative) closing balances as a positive number.
  ctl_line_count   integer     NOT NULL CHECK (ctl_line_count >= 0),
  ctl_sum_debit    app.money   NOT NULL CHECK (ctl_sum_debit >= 0),
  ctl_sum_credit   app.money   NOT NULL CHECK (ctl_sum_credit >= 0),
  -- Digest over all lines, fixed when the import closes and re-verified at
  -- lock. tb_lines are too voluminous for the row-level audit chain; this
  -- digest (which IS chained, via trial_balances) makes line tampering evident.
  lines_sha256     app.sha256,
  locked_by        uuid,
  locked_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by       uuid        NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, engagement_id),                           -- target for I3
  UNIQUE (tenant_id, engagement_id, tb_kind, version),
  FOREIGN KEY (tenant_id, engagement_id) REFERENCES app.engagements (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)    REFERENCES app.users (tenant_id, id),
  FOREIGN KEY (tenant_id, locked_by)     REFERENCES app.users (tenant_id, id),
  CHECK (source_object_key LIKE 'tenants/' || tenant_id::text || '/%'),
  CHECK ((locked_at IS NULL) = (locked_by IS NULL)),
  CHECK (status <> 'locked' OR locked_at IS NOT NULL)
);
-- At most one locked TB per engagement & kind: the one FS generation reads.
CREATE UNIQUE INDEX trial_balances_one_locked_uq
  ON app.trial_balances (tenant_id, engagement_id, tb_kind) WHERE status = 'locked';

CREATE TABLE app.tb_lines (
  tenant_id                uuid       NOT NULL,
  id                       uuid       NOT NULL DEFAULT gen_random_uuid(),
  trial_balance_id         uuid       NOT NULL,
  engagement_id            uuid       NOT NULL,
  line_no                  integer    NOT NULL CHECK (line_no > 0),
  client_account_code      text       NOT NULL CHECK (length(client_account_code) BETWEEN 1 AND 64),
  client_account_name      text       NOT NULL CHECK (length(client_account_name) BETWEEN 1 AND 512),
  -- NFKC + Arabic normalisation (alef/yaa/taa-marbuta folding, tashkeel &
  -- tatweel removal) + bidi-control stripping. Used for matching only; the
  -- verbatim name above is what auditors see and sign.
  client_account_name_norm text       NOT NULL,
  opening_balance          app.money,
  period_debit             app.money  CHECK (period_debit  >= 0),
  period_credit            app.money  CHECK (period_credit >= 0),
  closing_balance          app.money  NOT NULL,           -- signed: debit +, credit -
  source_had_formula       boolean    NOT NULL DEFAULT false,  -- cached value used; formula never evaluated
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by               uuid       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, trial_balance_id),
  UNIQUE (tenant_id, trial_balance_id, line_no),
  FOREIGN KEY (tenant_id, trial_balance_id, engagement_id)
    REFERENCES app.trial_balances (tenant_id, id, engagement_id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.users (tenant_id, id)
) PARTITION BY HASH (tenant_id);

DO $$
BEGIN
  FOR i IN 0..7 LOOP
    EXECUTE format(
      'CREATE TABLE app.tb_lines_p%s PARTITION OF app.tb_lines FOR VALUES WITH (MODULUS 8, REMAINDER %s)', i, i);
  END LOOP;
END
$$;
-- Covering index for "sum the TB" and control-total re-verification (index-only scan).
CREATE INDEX tb_lines_tb_cover_ix ON app.tb_lines (tenant_id, trial_balance_id)
  INCLUDE (closing_balance, period_debit, period_credit);

-- ---------------------------------------------------------------------------
-- Account mapping (client GL line -> standard COA), AI-suggested, human-decided
-- ---------------------------------------------------------------------------
CREATE TABLE app.account_mappings (
  tenant_id         uuid        NOT NULL,
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  engagement_id     uuid        NOT NULL,
  trial_balance_id  uuid        NOT NULL,
  tb_line_id        uuid        NOT NULL,
  coa_account_id    uuid        NOT NULL,
  source            app.mapping_source NOT NULL,
  confidence        numeric(5, 4) CHECK (confidence BETWEEN 0 AND 1),
  model_ref         text,          -- model id + prompt-template hash + retrieval index version
  rationale         text           CHECK (length(rationale) <= 2000),
  status            app.mapping_status NOT NULL DEFAULT 'suggested',
  decided_by        uuid,
  decided_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by        uuid        NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, tb_line_id, trial_balance_id)
    REFERENCES app.tb_lines (tenant_id, id, trial_balance_id),
  FOREIGN KEY (tenant_id, trial_balance_id, engagement_id)
    REFERENCES app.trial_balances (tenant_id, id, engagement_id),
  FOREIGN KEY (tenant_id, coa_account_id) REFERENCES app.coa_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by)     REFERENCES app.users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)     REFERENCES app.users (tenant_id, id),
  CHECK ((status IN ('accepted', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)
         OR status = 'superseded'),
  CHECK (source NOT IN ('llm', 'embedding') OR model_ref IS NOT NULL)
);
CREATE UNIQUE INDEX account_mappings_one_accepted_uq
  ON app.account_mappings (tenant_id, tb_line_id) WHERE status = 'accepted';
CREATE INDEX account_mappings_rollup_ix
  ON app.account_mappings (tenant_id, trial_balance_id, coa_account_id)
  INCLUDE (tb_line_id) WHERE status = 'accepted';

-- ---------------------------------------------------------------------------
-- Workpapers, immutable versions, 3-tier sign-offs, evidence
-- ---------------------------------------------------------------------------
CREATE TABLE app.workpapers (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  engagement_id    uuid        NOT NULL,
  ref_code         text        NOT NULL CHECK (ref_code ~ '^[A-Z]{1,3}-?[0-9]{1,4}(\.[0-9]{1,3})*$'),
  title            text        NOT NULL,
  title_ar         text,
  phase            app.engagement_stage NOT NULL CHECK (phase NOT IN ('completed', 'archived')),
  coa_path         ext.ltree,                     -- FS area the WP supports (lead schedule link)
  status           app.workpaper_status NOT NULL DEFAULT 'draft',   -- derived; see triggers
  current_version  integer     NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, engagement_id),
  UNIQUE (tenant_id, engagement_id, ref_code),
  FOREIGN KEY (tenant_id, engagement_id) REFERENCES app.engagements (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)    REFERENCES app.users (tenant_id, id)
);
CREATE INDEX workpapers_status_ix ON app.workpapers (tenant_id, engagement_id, status);

CREATE TABLE app.workpaper_versions (
  tenant_id          uuid        NOT NULL,
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  workpaper_id       uuid        NOT NULL,
  engagement_id      uuid        NOT NULL,
  version_no         integer     NOT NULL CHECK (version_no > 0),   -- assigned by trigger
  content            jsonb       NOT NULL,        -- structured WP body (procedures, conclusions, tickmarks)
  content_sha256     app.sha256  NOT NULL,        -- recomputed by trigger; what signers attest to
  change_note        text,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by         uuid        NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, workpaper_id),
  UNIQUE (tenant_id, workpaper_id, version_no),
  FOREIGN KEY (tenant_id, workpaper_id, engagement_id)
    REFERENCES app.workpapers (tenant_id, id, engagement_id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.users (tenant_id, id),
  CHECK (pg_column_size(content) <= 4 * 1024 * 1024)
);

CREATE TABLE app.workpaper_signoffs (
  tenant_id         uuid        NOT NULL,
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  workpaper_id      uuid        NOT NULL,
  engagement_id     uuid        NOT NULL,
  version_id        uuid        NOT NULL,
  level             app.signoff_level NOT NULL,
  signed_by         uuid        NOT NULL,           -- forced to the ctx actor by trigger
  signer_role       app.engagement_role NOT NULL,   -- snapshot at signing time (trigger)
  content_sha256    app.sha256  NOT NULL,           -- must equal the version hash
  step_up_assertion jsonb,                          -- WebAuthn assertion for reviewer/partner
  signed_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, version_id, level),
  FOREIGN KEY (tenant_id, version_id, workpaper_id)
    REFERENCES app.workpaper_versions (tenant_id, id, workpaper_id),
  FOREIGN KEY (tenant_id, workpaper_id, engagement_id)
    REFERENCES app.workpapers (tenant_id, id, engagement_id),
  FOREIGN KEY (tenant_id, signed_by) REFERENCES app.users (tenant_id, id)
);
CREATE INDEX workpaper_signoffs_wp_ix ON app.workpaper_signoffs (tenant_id, workpaper_id, version_id);

CREATE TABLE app.evidence_files (
  tenant_id          uuid        NOT NULL,
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  engagement_id      uuid        NOT NULL,
  workpaper_id       uuid,
  object_key         text        NOT NULL,
  object_version_id  text,                         -- S3 version id (bucket has Object Lock)
  sha256             app.sha256  NOT NULL,
  byte_size          bigint      NOT NULL CHECK (byte_size > 0 AND byte_size <= 5368709120),
  original_filename  text        NOT NULL CHECK (length(original_filename) <= 255),
  detected_mime      text        NOT NULL,         -- magic-byte sniffed, not client-declared
  scan_status        app.scan_status NOT NULL DEFAULT 'pending',
  scanned_at         timestamptz,
  retain_until       date        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by         uuid        NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, object_key),
  FOREIGN KEY (tenant_id, engagement_id) REFERENCES app.engagements (tenant_id, id),
  FOREIGN KEY (tenant_id, workpaper_id, engagement_id)
    REFERENCES app.workpapers (tenant_id, id, engagement_id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.users (tenant_id, id),
  -- Storage namespace is bound to the tenant at the DB level: a row can never
  -- point at another tenant's S3 prefix, whatever the app does.
  CHECK (object_key LIKE 'tenants/' || tenant_id::text || '/engagements/' || engagement_id::text || '/%'),
  CHECK ((scan_status = 'pending') = (scanned_at IS NULL))
);
CREATE INDEX evidence_files_wp_ix ON app.evidence_files (tenant_id, engagement_id, workpaper_id);

-- ---------------------------------------------------------------------------
-- Adjusting journal entries (header + lines)
-- ---------------------------------------------------------------------------
CREATE TABLE app.adjusting_entries (
  tenant_id          uuid        NOT NULL,
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  engagement_id      uuid        NOT NULL,
  entry_no           integer     NOT NULL,         -- gapless per engagement (trigger)
  entry_type         app.aje_type NOT NULL,
  description        text        NOT NULL CHECK (length(description) BETWEEN 5 AND 2000),
  effective_date     date        NOT NULL,         -- accounting date; must fall in the period
  status             app.aje_status NOT NULL DEFAULT 'draft',
  reverses_entry_id  uuid,
  workpaper_id       uuid,                         -- supporting workpaper
  approved_by        uuid,
  approved_at        timestamptz,
  posted_by          uuid,
  posted_at          timestamptz,                  -- system time; cannot be back-dated
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by         uuid        NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, engagement_id),
  UNIQUE (tenant_id, engagement_id, entry_no),
  FOREIGN KEY (tenant_id, engagement_id) REFERENCES app.engagements (tenant_id, id),
  FOREIGN KEY (tenant_id, reverses_entry_id, engagement_id)
    REFERENCES app.adjusting_entries (tenant_id, id, engagement_id),
  FOREIGN KEY (tenant_id, workpaper_id, engagement_id)
    REFERENCES app.workpapers (tenant_id, id, engagement_id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES app.users (tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by)   REFERENCES app.users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)  REFERENCES app.users (tenant_id, id),
  CHECK (entry_type <> 'PAJE' OR status <> 'posted'),                    -- passed = never booked
  CHECK (status NOT IN ('approved', 'posted') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK ((status = 'posted') = (posted_by IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_by <> created_by),              -- maker-checker
  CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id)
);
-- An entry can be reversed at most once (ignoring rejected attempts).
CREATE UNIQUE INDEX adjusting_entries_single_reversal_uq
  ON app.adjusting_entries (tenant_id, reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL AND status <> 'rejected';
CREATE INDEX adjusting_entries_posted_ix
  ON app.adjusting_entries (tenant_id, engagement_id, entry_type) WHERE status = 'posted';

CREATE TABLE app.adjusting_entry_lines (
  tenant_id       uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  entry_id        uuid        NOT NULL,
  engagement_id   uuid        NOT NULL,
  line_no         integer     NOT NULL CHECK (line_no > 0),
  coa_account_id  uuid        NOT NULL,
  amount          app.money   NOT NULL CHECK (amount <> 0),   -- signed: debit +, credit -
  memo            text        CHECK (length(memo) <= 500),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by      uuid        NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, entry_id, line_no),
  FOREIGN KEY (tenant_id, entry_id, engagement_id)
    REFERENCES app.adjusting_entries (tenant_id, id, engagement_id),
  FOREIGN KEY (tenant_id, coa_account_id) REFERENCES app.coa_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)     REFERENCES app.users (tenant_id, id)
);
CREATE INDEX adjusting_entry_lines_rollup_ix
  ON app.adjusting_entry_lines (tenant_id, engagement_id, coa_account_id) INCLUDE (amount, entry_id);
CREATE INDEX adjusting_entry_lines_entry_ix
  ON app.adjusting_entry_lines (tenant_id, entry_id) INCLUDE (amount);
