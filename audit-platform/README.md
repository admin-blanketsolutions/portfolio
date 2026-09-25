# Audit Management Platform: Phase 1 secure core + Phase 3 TB ingestion and review

A multi-tenant SaaS core for audit firms (ISA / ISQM, IFRS, ISO/IEC 27001, Jordan & MENA residency). The platform covers engagement workflow, AI-assisted trial-balance mapping, digital workpapers with 3-tier sign-off, sampling, and FS generation from TB + AJEs. This directory holds the **architecture review, the roadmap, and the executed Phase 1 foundation**: the PostgreSQL schema with the security model enforced in the database, and the TypeScript/NestJS tenant-context runtime. It also holds the first Phase 3 slices: trial-balance import, AI-assisted account mapping, and the bilingual (EN/AR, RTL) web review interface.

| Step | Deliverable | Where |
|---|---|---|
| 1 | Adversarial architecture & security review | [`docs/01-adversarial-security-review.md`](docs/01-adversarial-security-review.md) |
| 2 | Master implementation blueprint (Phases 1–6, stack, API, testing) | [`docs/02-implementation-blueprint.md`](docs/02-implementation-blueprint.md) |
| 3.1 | Architecture & security trade-off matrix | [`docs/03-architecture-security-tradeoff-matrix.md`](docs/03-architecture-security-tradeoff-matrix.md) |
| 3.2 | Core relational schema (SQL DDL) + data model & indexing | [`db/migrations/`](db/migrations), [`docs/04-data-model-and-indexing.md`](docs/04-data-model-and-indexing.md) |
| 3.3 | Backend skeleton for secure tenant context switching | [`backend/src/`](backend/src) |
| P3.1 | Trial-balance import & AI-assisted mapping: sandboxed parser, mapping cascade, review API, lock | [`parser/`](parser), [`V0010`](db/migrations/V0010__tb_ingestion_and_mapping.sql), [`backend/src/modules/tb-ingestion/`](backend/src/modules/tb-ingestion) |
| P3.2 | Mapping review UI (Next.js, EN/AR + RTL, strict CSP), per-tenant web login config, `/auth/config` + `/me` | [`web/`](web), [`V0011`](db/migrations/V0011__web_login_config.sql), [`backend/src/modules/session/`](backend/src/modules/session) |

## Layout

```
audit-platform/
├── db/
│   ├── migrations/
│   │   ├── V0001__roles_schemas_extensions.sql   least-privilege roles, schemas, extensions
│   │   ├── V0002__signed_tenant_context.sql      HMAC-signed app.ctx verified in-DB
│   │   ├── V0003__core_schema.sql                tenants, users, clients, engagements, COA, TB, mappings,
│   │   │                                         workpapers/versions/sign-offs, evidence, AJEs
│   │   ├── V0004__row_level_security.sql         FORCE RLS + ethical walls + client-portal walls
│   │   ├── V0005__integrity_and_immutability.sql state machines, sign-off rules, ledger rules, archive lock
│   │   ├── V0006__tamper_evident_audit_chain.sql per-tenant SHA-256 chain, verification, anchors
│   │   ├── V0007__balance_rollups.sql            TB + AJE → FS roll-ups (ltree), integrity checks
│   │   ├── V0008__provisioning_and_grants.sql    tenant provisioning, grants
│   │   ├── V0009__authn_resolution.sql           tenant directory, issuer-bound principal lookup, enter_context
│   │   ├── V0010__tb_ingestion_and_mapping.sql   uploads, ingestion service principal, mapping rules, provenance
│   │   └── V0011__web_login_config.sql           per-tenant public OIDC client for the web app (login discovery)
│   ├── tests/                                    00_fixtures + 9 SQL security/integrity suites
│   └── scripts/test.sh                           fresh DB → migrate → fixtures → suites
├── parser/                                       sandboxed TB parser (Python): xlsx/csv -> typed lines + control totals
│   ├── tb_parser/    OOXML pre-flight, header/layout detection (EN/AR), amounts, normalisation, CLI
│   └── tests/        unit, property-based (Hypothesis), malicious-workbook corpus, shared golden vectors
├── backend/
│   ├── src/
│   │   ├── tenancy/      context (ALS), signer, guard, interceptor, directory, OIDC verifier, module
│   │   ├── database/     pool, TenantDb (tx-local signed context), SQL guard
│   │   ├── jobs/         sealed job envelopes, in-process queue
│   │   ├── cache/        tenant/user-scoped cache keys
│   │   ├── storage/      tenant-bound S3 keys, per-tenant KMS, Object Lock
│   │   ├── common/       domain errors, safe PG error mapping, exception filter
│   │   └── modules/      engagements, tb-ingestion (upload, worker, cascade, LLM stage, review API), session, health
│   ├── scripts/          dev-stack.mjs: local API + dev IdP/token helper (development only)
│   └── test/             unit · integration · HTTP e2e (135 tests)
├── web/                                          Next.js review UI (see web/README.md)
│   ├── app/ · src/       pages, components, API client, OIDC PKCE auth, EN/AR catalogs, amount formatting
│   └── tests/            vitest + Testing Library (unit/component) · Playwright (real build, mocked API)
└── docs/
```

## How the tenant boundary works

```
Host: alpha-audit.app.example.com
  └─► platform.tenant_directory(slug) ─► registered OIDC issuer, home region (421 if wrong region)
Authorization: Bearer <JWT>
  └─► verify ONLY against that issuer's JWKS (pinned algs, audience)
  └─► platform.resolve_principal(slug, iss, sub) ─► user id, kind, admin flag
TenantContextInterceptor ─► AsyncLocalStorage.run(ctx, next.handle)
TenantDb.transaction(work)
  BEGIN
  SELECT … FROM app.enter_context('v1.<key>.<tenant>.<user>.<flags>.<exp>.<hmac>')   -- tx-local, verified in-DB
  … repository SQL (guarded; extended protocol) …   ◄── RLS: tenant_id = verified ctx
  COMMIT                                                ethical walls, client walls, triggers
```

## Trial-balance ingestion (Phase 3, slice 1)

```
staff uploads xlsx/csv ──► tb_imports (received) + WORM object ──► sealed job
worker (tenant's ingestion service principal, only for that uploader's import)
  └─► sandboxed parser (no formulas evaluated, no active content, exact decimals, EN/AR headers)
  └─► trial_balances + tb_lines ──► DB re-verifies control totals, fixes the line digest
  └─► suggestions: carry-forward ► firm rules ► exact name ► LLM (tenant opt-in, schema-constrained)
reviewer: lines with provenance + flags ─► bulk-accept unflagged / accept flagged explicitly / manual
senior: lock (balanced, every line human-accepted, digest intact) ─► FS roll-up
```

The database, not the API, enforces the rules: machine sources are written only by service principals, decisions only by human staff, mappings only to postable accounts, and the LLM stage is off unless both the deployment and the tenant's control-plane policy enable it.

## Running the tests

Requirements: PostgreSQL 16 (superuser for the throwaway test DB), Node 22, Python 3.11+.

```bash
# 0. Parser (the backend's integration tests spawn this virtualenv's interpreter)
cd parser && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest && cd ..

# 1. SQL suites (creates, migrates, tests and drops a fresh database)
ADMIN_URL=postgresql://postgres@localhost:5432/postgres ./db/scripts/test.sh

# 2. Backend: keep the DB from step 1 and point the tests at it
KEEP_DB=1 ADMIN_URL=postgresql://postgres@localhost:5432/postgres ./db/scripts/test.sh   # prints DATABASE_URL=…/audit_test_…
cd backend && npm ci
ADMIN_DATABASE_URL=postgresql://postgres@localhost:5432/<db> \
DATABASE_URL=postgresql://audit_app_it:it-only@localhost:5432/<db> \
npm test
```

```bash
# 3. Web: typecheck, component tests, then browser tests against a production build
cd web && npm ci && npm run typecheck && npm test
npx playwright install chromium   # or PW_CHROMIUM_PATH=/path/to/chromium
npm run test:e2e
```

CI runs all of them (SQL and backend against a `postgres:16` service): `.github/workflows/audit-platform-ci.yml`.

### Running the whole stack locally

```bash
# a migrated database with fixtures (step 2 above), then:
cd backend && ADMIN_DATABASE_URL=… DATABASE_URL=… npm run dev:stack   # API on 127.0.0.1:3000, token helper on :3999
cd web && NEXT_PUBLIC_AUTH_MODE=dev-token API_ORIGIN=http://127.0.0.1:3000 npm run dev   # UI on :3001
```

`dev:stack` refuses to start with `NODE_ENV=production`; it signs short-lived development tokens with a throwaway key and registers `.test` issuers for the fixture tenants. `npm run smoke:fullstack` in `web/` drives the complete flow (upload, bulk accept, manual mapping, a junior's refused lock, a senior's lock, Arabic view) and saves screenshots.

### What the suites prove

| Suite | Highlights |
|---|---|
| `10_schema_lint` | Every table: ENABLE+FORCE RLS, tenant-first PK, tenant-scoped FKs/uniques; no MVs; definer hygiene; no PUBLIC execute; no floats; app role owns nothing, no TRUNCATE, no partition access |
| `20_tenant_isolation` | Fail-closed without context; forged, escalated, extended, malformed, unknown-key and expired contexts rejected; cross-tenant writes blocked; FK oracles closed |
| `30_ethical_walls` | Non-members see headers but never content; admins not exempt (self-staffing is chained); removed members lose access; client-portal isolation; storage-prefix CHECK; retention floor |
| `40_workpaper_signoffs` | DB-assigned versions/hashes, server time, no impersonation, SoD, order, step-up, hash binding, stale-version refusal, append-only (even for superuser with triggers on) |
| `50_tb_mapping_aje_rollup` | Control-total reconciliation, frozen lines, prompt-injected account name rejected by a human, AI cannot accept, DBA line tampering caught by digest, maker-checker, in-period posting, exact reversals, gapless numbering, roll-up totals |
| `60_audit_chain` | Out-of-band DBA edit self-identifies; single-event edit, tail truncation and **full consistent rewrite** detected (the last via the anchor) |
| `70_engagement_lifecycle` | ISA 320/220 gates, completion gates (report date, locked TB, partner-approved WPs, no open AJEs), partner-only archive, archive lock on every write path |
| `80_authn_resolution` | Issuer confusion blocked, suspended users don't resolve, **service principals never resolve via an IdP token**, lookup doesn't open `app.users`, `enter_context` refuses double entry |
| `90_tb_ingestion` | Uploads by engagement staff only; status machine run only by the ingestion principal; an import binds only to the TB built from its own file; machine vs human provenance on mappings; postable-only targets; admin-only rules; walls; chained |
| `parser/tests` | Hostile workbooks (VBA, XLM, DDE/external links, OLE, ActiveX, XXE, billion laughs, zip bombs, zip-slip, sparse 1M-row sheets, lying dimension tag), formula handling, EN/AR two-row headers, Arabic digits, control totals exact under Hypothesis |
| `web/tests` | Only unflagged suggestions reach a bulk acceptance; flagged ones need an explicit acknowledgement; hostile account names render as inert, direction-isolated text; debit/credit columns; EN↔AR with RTL; in a real browser: upload → poll → review → map → lock with zero CSP violations, fresh nonce per request, no `unsafe-inline`/`unsafe-eval` |
| `backend/test` | HMAC compatibility TS↔SQL, 400-flow ALS isolation, 60 interleaved transactions on a pool of 3 without leakage, HTTP e2e with real ES256 JWTs from two independent IdPs, 40 concurrent cross-tenant requests, safe error mapping; TB e2e: upload → real sandboxed parser → cascade → flags → bulk/individual/manual decisions → lock → FS roll-up, LLM gate and data minimisation, carry-forward, forged/replayed job envelopes, attribution in the audit chain |

## Security posture in one paragraph

Tenant isolation, ethical walls, sign-off rules, ledger rules and immutability are enforced **by PostgreSQL**, so an API bug, a compromised service or a hand-written SQL session cannot bypass them. The tenant context is **signed**, so SQL injection cannot pivot tenants. It is **transaction-local**, so pooled connections cannot leak it. It is **carried by AsyncLocalStorage**, so concurrent requests cannot see each other's context. Everything the law treats as a record is append-only and **hash-chained**; external **anchors** make even a superuser's rewrite detectable. The remaining trust assumptions (RCE on the API host, collusion, DB superuser between anchors) are listed with their mitigations in `docs/03`.
