# 02 — Master Implementation Blueprint (Phases 1–6)

## 1. Target architecture

```
                         ┌──────────────────── Region cell (e.g. me-central-1) ───────────────────┐
 <firm>.app.example.com  │                                                                         │
 ── CloudFront/WAF ──►   │  ALB ─► API (NestJS, Node 22)        ─► PostgreSQL 16 (RDS/Aurora PG)   │
                         │         • TenantContextGuard (OIDC)       • FORCE RLS + signed ctx       │
 Firm IdPs (OIDC/SAML)   │         • ALS interceptor                 • triggers, hash chain         │
 Entra ID / Google /     │         • TenantDb (tx-local ctx)       ─► Redis (ElastiCache): cache,   │
 Keycloak per tenant ──► │                                            rate limits, BullMQ          │
                         │  Workers (Node) ── sealed job envelopes ──► SQS / BullMQ                 │
                         │  Parser sandbox (Python, no egress) ◄── quarantine S3 ── GuardDuty scan  │
                         │  AI mapping svc (Python/FastAPI) ──► Bedrock / self-hosted LLM (region) │
                         │  S3 evidence (Object Lock, SSE-KMS per tenant)                          │
                         └─────────────────────────────────────────────────────────────────────────┘
   Separate AWS accounts:  security · log-archive (pgaudit, CloudTrail) · evidence-anchors (Object Lock
                           COMPLIANCE + KMS signing key) · shared-services (CI/CD) · prod cells · non-prod
   Sovereign cell (JO):    same containers on Kubernetes in-country; Vault/HSM; MinIO (object lock); local LLM
```

### 1.1 Technology selections

| Concern | Choice | Why | Rejected |
|---|---|---|---|
| Core API | **TypeScript / NestJS 12 on Node 22** | Strong typing across API and domain; DI and modules map onto bounded contexts; AsyncLocalStorage is mature | Django (heavier ORM habits that fight RLS); Go (slower domain modelling for a large team) |
| AI, parsing, statistics | **Python 3.12 / FastAPI** workers | `openpyxl`, `defusedxml`, `oletools`, `numpy`/`scipy` (MUS, stratification), NLP and embeddings | Running file parsing in the API process (blast radius) |
| Database | **PostgreSQL 16** (RDS/Aurora in-region; vanilla PG in the sovereign cell) | RLS, `FORCE`, security-invoker, ltree, pgcrypto, partitioning, strong NUMERIC | NoSQL (needs relational integrity and ledger constraints); QLDB (end of support 31 Jul 2025) |
| Data access | `pg` + a thin typed repository layer (Kysely can sit on top) | Explicit transactions: `set_config(…, true)` must share the transaction with the work | Prisma (interactive-transaction model makes tx-local context awkward) |
| Cache / queues | **Redis** (ElastiCache, cluster mode) + **BullMQ**; SQS for cross-account | Rate limits, short-lived caches, job fan-out | — |
| Object storage | **S3** with Object Lock (COMPLIANCE), per-tenant SSE-KMS; MinIO in the sovereign cell | Record-retention enforcement outside the DB | — |
| Keys | **AWS KMS** (per-tenant CMKs), **XKS** for in-country custody; Vault in the sovereign cell | Separation of duties, crypto-shredding | Single shared key |
| Identity | **Per-tenant OIDC federation** (firm's Entra ID / Google / Okta), Keycloak for firms without an IdP; **WebAuthn** step-up for sign-offs | Firms keep their joiner/mover/leaver process; phishing-resistant partner approval | Platform-owned passwords |
| Frontend | Next.js/React, RTL-first design system, ICU i18n (ar/en), Hijri+Gregorian display | Arabic-first market | — |
| IaC / CI | Terraform + GitHub Actions (OIDC to AWS), Checkov, Trivy, Semgrep, CodeQL, gitleaks | Reproducible, reviewable infra | Console changes |
| Observability | OpenTelemetry → CloudWatch/Grafana; SIEM (e.g. OpenSearch Security Analytics) | Tenant-tagged, PII-free telemetry | — |

### 1.2 Database design principles (applied in `db/migrations`)

1. **Tenant first:** `tenant_id` is the first PK column; all FKs and unique keys are tenant-scoped (lint-enforced).
2. **The database is the final authority:** RLS, state machines, sign-off rules, ledger rules and immutability live in the DB, so API bugs cannot bypass them.
3. **Server time, server identity:** triggers overwrite who/when columns.
4. **Append-only where the law expects records:** versions, sign-offs, events, evidence; corrections are new records (reversals, new versions).
5. **Money is NUMERIC** (scale 4 covers the 3-decimal JOD/KWD/BHD/OMR). Amounts cross into JS as strings, never as floats.
6. **Derived state is derived:** workpaper status, AJE numbers, TB supersession and lock metadata can only be written from inside triggers (`pg_trigger_depth() > 1`).
7. **No materialized views; roll-ups are INVOKER functions** over covering indexes; snapshots (Phase 4) are RLS'd tables.
8. **Bilingual by schema:** `*_ar` columns beside English; the verbatim client text is kept separately from the normalized matching text.
9. **Portable primitives only** in the core (sovereign-cell requirement).

### 1.3 API structure

* **Addressing:** `https://<firm-slug>.app.example.com/v1/...`. The tenant comes from the host and is bound to the firm's IdP issuer; it is never taken from path, query or body.
* **Resources** (REST, OpenAPI 3.1, JSON; money as decimal strings):

| Resource | Endpoints (examples) |
|---|---|
| Engagements | `GET /engagements`, `POST /engagements`, `POST /engagements/{id}/stage`, `GET /engagements/{id}/fs-rollup` |
| Team | `PUT /engagements/{id}/members/{userId}`, `POST /engagements/{id}/members/{userId}/independence` |
| Workpapers | `POST /engagements/{id}/workpapers`, `POST /workpapers/{id}/versions`, `POST /workpapers/{id}/signoffs` (WebAuthn assertion over the content hash), `GET /workpapers/{id}/history` |
| Evidence | `POST /engagements/{id}/evidence:presign` → PUT to S3 → `POST /engagements/{id}/evidence` |
| Trial balance *(implemented, Phase 3 slice 1)* | `POST /engagements/{id}/tb-imports?filename=…` (raw xlsx/csv body) → **202**, `GET /tb-imports/{id}`, `GET /engagements/{id}/tb-imports`, `GET /trial-balances/{id}`, `GET /trial-balances/{id}/lines?afterLine=&limit=` (suggestion + provenance + reviewer flags per line), `POST /mappings/{id}/accept` (flagged ⇒ `acknowledgeFlags`), `POST /mappings/{id}/reject`, `POST /trial-balances/{id}/bulk-accept` (unflagged only), `POST /trial-balances/{id}/lines/{lineId}/mapping` (manual), `POST /trial-balances/{id}/lock`, `GET /coa`, `GET|POST /mapping-rules`, `POST /mapping-rules/{id}/deactivate`; lines filter `status=open|pending|accepted|unmapped|all` |
| Session *(implemented)* | `GET /auth/config` (public; the tenant's issuer, web client id, audience and scope, resolved from the `Host`), `GET /me` (display names EN/AR, rank, admin flag) |
| Ledger | `POST /engagements/{id}/adjusting-entries`, `POST /adjusting-entries/{id}:propose|approve|post|void`, `GET /engagements/{id}/uncorrected-misstatements` (ISA 450) |
| FS | `POST /engagements/{id}/financial-statements:render` → 202, `GET /financial-statements/{id}` (hash-stamped PDF/iXBRL) |
| Sampling | `POST /engagements/{id}/samples` (method, population, parameters, **seed**), `POST /samples/{id}:evaluate` |
| Portal | `GET /portal/requests`, `POST /portal/requests/{id}/uploads` |
| Audit | `GET /audit/events?engagementId=…`, `POST /audit:verify` (admin) |

* **Conventions:** `Idempotency-Key` on every POST; optimistic concurrency with `ETag`/`If-Match`; cursor pagination; long work returns `202` + `/jobs/{id}`; uniform error envelope `{error, message, requestId}` with no driver detail; per-tenant and per-user rate limits; `Cache-Control: private, no-store`.

---

## 2. Phased roadmap

Indicative effort for a team of 6–8 engineers (2 backend, 1 data/AI, 2 frontend, 1 platform/SRE, 1 QA/security, plus a part-time audit SME).

### Phase 1 — Secure foundation (weeks 0–8) · **core delivered in this repository**

| Workstream | Deliverables | Status |
|---|---|---|
| Data core | Schema for tenants, users, clients, engagements, members, COA (ltree), TB + lines (partitioned), mappings, workpapers, versions, sign-offs, evidence, AJEs; RLS with ethical walls; integrity triggers; hash chain; roll-up functions; provisioning; authn lookups | ✅ `db/migrations/V0001–V0009` |
| Tenancy runtime | Signed context, ALS, guard, interceptor, TenantDb, SQL guard, error mapping, job envelopes, tenant cache, tenant object store, example module | ✅ `backend/src` |
| Tests | 8 SQL suites (lint, isolation, walls, sign-off, TB/AJE/roll-up, chain tamper, lifecycle, authn) + 78 TS tests (unit, DB integration, HTTP e2e) | ✅ |
| Platform | Terraform landing zone (accounts, SCPs, VPC, RDS PG16 with IAM auth + `pgaudit`, KMS, Secrets Manager, ElastiCache, S3 Object Lock buckets, CloudTrail org trail → log-archive) | ☐ next |
| Identity | Per-tenant OIDC onboarding; Keycloak realm template; MFA enforcement | ◐ OIDC discovery, per-firm web client, sign-in and IdP sign-out tested against real Keycloak realms; production realm template with MFA ☐ |
| CI/CD | Pipelines: lint, typecheck, unit, SQL suites against an ephemeral PG, integration, SAST/SCA/IaC scan, SBOM, signed images | ◐ workflow included |
| Governance | ISMS scope, risk register (from `03`), SoA draft, DPIA for PDPL, sub-processor register | ☐ |

**Exit criteria:** every Phase 1 test green in CI; external review of the RLS/context design; threat model signed off; restore drill of PITR with chain verification.

### Phase 2 — Engagement workflow, workpapers, evidence, portal v1 (weeks 8–18)

* Stage UI; planning (materiality calculator, ISA 320 benchmarks); risk register (ISA 315) scaffold.
* Workpaper editor (structured JSON blocks, tick-marks, cross-references), review notes, **WebAuthn verification server-side** (challenge = content SHA-256; the DB currently checks presence only).
* Evidence pipeline: presigned upload → quarantine → malware scan → promote with Object Lock → `scan_status` by the service principal.
* PBC portal v1: request lists, due dates, reminders, client uploads (client-contact RLS already in place).
* **Anchoring job** (separate account, KMS asymmetric signing, Object Lock) with `verify_chain` alarms.
* ISA 230.16 post-assembly addendum workflow; EQR (ISQM 2) sign-off level for PIE clients.
* Tests: Playwright E2E per role; WebAuthn virtual authenticator; anchor-divergence alarm test.

### Phase 3 — TB ingestion & AI mapping (weeks 16–28) · **slices 1–2 delivered in this repository**

| Workstream | Deliverables | Status |
|---|---|---|
| Parser | `parser/tb_parser`: .xlsx/.csv only; OOXML pre-flight (macros, XLM, DDE/external links, OLE, ActiveX, DTD/XXE, zip bombs, zip-slip, encryption); openpyxl read-only with cached values (formulas never evaluated; formula without a saved value refused); dimension tag not trusted; EN/AR header detection incl. two-row headers; four layouts; exact decimals (Arabic digits/separators, `(1,234)`, Dr/Cr suffixes); bidi/zero-width stripping; control totals; CLI with rlimits | ✅ 121 pytest (property + malicious corpus) |
| Data | `V0010`: `tb_imports` (upload record, service-only status machine bound to its TB), `mapping_rules`, per-tenant ingestion service principal (never resolvable via OIDC), machine-vs-human provenance on mappings, postable-only targets, tenant LLM opt-in | ✅ suite `90_tb_ingestion` |
| Cascade | carry-forward (previous TB version, prior-year locked TB — same client only) → firm rules → exact name (COA or client history) → LLM (Claude, schema-constrained to the firm's postable codes) → human decision | ✅ embedding stage ☐ |
| Review API | status polling, lines with provenance and flags, accept/reject/manual, bulk accept of unflagged, lock | ✅ HTTP e2e |
| Review UI | `web/`: Next.js 16, OIDC PKCE (tokens in memory only), per-tenant login discovery (`V0011`, `/auth/config`), upload with status polling, lines with provenance/flags, bulk accept of unflagged only, explicit acknowledgement for flagged, manual mapping with a recorded reason, lock; EN/AR with RTL; exact string-based amounts; per-request nonce CSP with `strict-dynamic` | ✅ vitest + Playwright |
| Deployability | S3 + Object Lock adapter (create-only writes, checksums both ways, boot-time bucket verification); network-less single-use parser container (digest-pinned image, isolation proven by probes); production config refuses the in-memory store and the unsandboxed parser | ✅ moto + Docker suites |
| Still to build | quarantine bucket + malware scan before parsing; embedding kNN stage; evaluation harness and red-team CI gate against a real model; multi-currency / IAS 21; keyboard-first review at 50k lines (virtualised table); accessibility audit (WCAG 2.2 AA) | ☐ |

* Sandboxed parser (Python) with the hardening in `01 §3.2`; Arabic normalization library with golden tests.
* Mapping cascade (carry-forward → rules → exact → embedding → LLM) with `model_ref` provenance and a human-decision UI (bulk accept with per-row flags).
* Evaluation harness: labelled AR/EN corpus, precision@1 ≥ target per release; **prompt-injection red-team suite** as a CI gate; drift dashboard.
* Multi-currency TB and IAS 21 translation (rates table, CTA to OCI).
* Tests: property-based parser fuzzing (Hypothesis) with a malicious-workbook corpus (zip bombs, XXE, DDE, formula-injection, bidi), 50k-line TB import < 30 s p95.

### Phase 4 — Ledger & automated financial statements (weeks 26–38)

* AJE/RJE/PAJE UI, ISA 450 summary of uncorrected misstatements against materiality, lead schedules from `fs_rollup`.
* FS engine: templates driven by COA paths; **IAS 1 and IFRS 18** layouts (IFRS 18 applies to annual periods beginning on or after 1 Jan 2027: operating/investing/financing categories in P&L, MPM disclosures); comparatives from `prior_year_final` TB; cash-flow statement (indirect method) from BS movements, `cash_flow_class` and non-cash adjustments; balance checks from `app.fs_integrity`.
* Deterministic rendering (PDF/A, bilingual RTL) → SHA-256 recorded in the audit chain; optional iXBRL with the IFRS taxonomy where a regulator requires it.
* Snapshot tables (RLS'd) of adjusted balances per FS version for fast re-render.
* Tests: golden FS fixtures; property tests (Σadjusted = 0, BS balances, CF reconciles to cash movement, RJEs don't change profit); performance: roll-up for 20k accounts < 200 ms.

### Phase 5 — Sampling, analytics, timesheets, portal v2 (weeks 36–46)

* Sampling per **ISA 530**: random and systematic (CSPRNG with **recorded seed** for re-performance), stratified (value bands, Neyman allocation), **MUS/PPS** (sample size from reliability factor × BV / (TM − EM × expansion factor); evaluation with basic precision + projected misstatement + incremental allowance, i.e. the Stringer bound); results stored immutably with parameters.
* Analytics: YoY/budget variance vs performance materiality thresholds, ratio analysis, Benford first-digit tests on GL detail, JE testing filters (ISA 240).
* Timesheets (budget vs actual by stage and rank), portal v2 (messaging, e-signature of representation letters: ISA 580).
* Tests: sampling statistics validated against published tables (e.g. AICPA Audit Sampling guide factors) and Monte-Carlo coverage tests.

### Phase 6 — Certification, sovereignty & scale (weeks 44–56+)

* ISO/IEC 27001:2022 Stage 1/2 audit (plus 27017/27018/27701 as the market requires); optional SOC 2 Type II.
* Independent penetration test focused on tenant isolation and sign-off forgery; bug bounty.
* **Sovereign cell** for Jordan (Kubernetes, Vault/HSM, MinIO object lock, self-hosted LLM) and **silo-tier** automation.
* DR: PITR (RPO ≤ 5 min), warm standby in a residency-compatible region (RTO ≤ 4 h), quarterly restore drills with chain verification.
* Tenant offboarding: export package plus retention-aware crypto-shredding; legal hold.
* Load: 2,000 concurrent users per cell; chaos tests (pool exhaustion, DB failover mid-posting).

---

## 3. Testing strategy (all phases)

| Layer | What | Tooling | Gate |
|---|---|---|---|
| Schema lint | RLS ENABLE+FORCE, tenant-first PK, tenant-scoped FKs and uniques, no MVs, definer hygiene, no PUBLIC execute, no floats | `db/tests/10_schema_lint.sql` | Every PR |
| Isolation matrix | Every table × {no ctx, other tenant, forged ctx, expired ctx, partition access} | `20_tenant_isolation.sql` | Every PR |
| Authorization | Ethical walls, client portal, role gates, NULL-safety | `30_*`, `40_*`, `70_*` | Every PR |
| Ledger correctness | Balanced, maker-checker, period, reversal, gapless, roll-up totals | `50_*` + property tests (fast-check) | Every PR |
| Tamper evidence | Edit, truncate and full-rewrite scenarios vs anchors | `60_audit_chain.sql` | Every PR |
| App tenancy | ALS isolation under concurrency, pooled-connection leak test, e2e issuer confusion | `backend/test/**` | Every PR |
| Mutation testing | Deliberately break policies and ordering; tests must fail (done manually in Phase 1; automate with Stryker for TS) | Stryker | Nightly |
| Parser/AI | Fuzzing, malicious corpus, injection red-team, mapping accuracy | Hypothesis, promptfoo-style evals | Release |
| Security scanning | SAST, SCA, secrets, IaC, container, DAST | Semgrep, CodeQL, Dependabot, gitleaks, Checkov, Trivy, ZAP | Every PR / nightly |
| Performance | TB import, roll-up, concurrent sign-off | k6, pgbench | Release |
| Resilience | Failover mid-transaction, pool exhaustion, Redis loss | Chaos experiments | Quarterly |
| External | Pentest, ISO audit, restore drills | — | Annually / quarterly |
