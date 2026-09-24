# 03 — Architecture & Security Trade-off Matrix

Legend: **L/I** = likelihood / impact (1–5) before → after the control. **Status:** ✅ implemented and tested in this repository · ◐ partially · ☐ planned (phase).

## A. Tenant isolation

| # | Vulnerability (from 01) | Options considered | Decision | Security gain | Cost / trade-off | Residual risk | L/I before → after | Verified by | Status |
|---|---|---|---|---|---|---|---|---|---|
| A1 | Missing tenant filter in app queries | App-side `WHERE tenant_id` · ORM global scope · **DB RLS** | FORCE RLS on every table; the app never relies on its own filter for security | A missed filter returns nothing instead of other tenants' rows | Policy overhead ≈ one InitPlan per statement; developers must learn RLS | Policy bug on a new table | 4/5 → 1/5 | `10` L1, `20` T1–T4 | ✅ |
| A2 | Pooled vs schema vs silo | Pooled · schema-per-tenant · DB-per-tenant | **Pooled default + silo tier + sovereign cell** | Silo for high-risk tenants; the pooled tier is hardened | Two operational modes; routing per cell | Pooled blast radius on a DB-engine bug | — | Design | ◐ (pooled ✅, silo/sovereign ☐ P6) |
| A3 | Context forgery through SQL injection | Plain GUC · per-tenant DB roles · **HMAC-signed GUC** | Signed, 60 s TTL token verified in-DB; key unreadable by app role | SQLi cannot pivot tenants | One HMAC per statement (≈µs); key rotation procedure | Full RCE on the API host can mint tokens (the key is in memory) | 3/5 → 1/5 | `20` T6, `tenant-db.test` | ✅ |
| A4 | Context leak on pooled connections | Session `SET` + `RESET` on release · **tx-local set_config** | Transaction-local context, `enter_context` refuses if one is present, suspect connections destroyed | PgBouncer-safe; leaks fail loudly | Every unit of work must be a transaction | Driver bug | 3/5 → 1/5 | 60 interleaved tx on pool=3 | ✅ |
| A5 | Async context loss in Node | Request-scoped DI · **AsyncLocalStorage** | ALS, frozen context, no cross-tenant nesting, ordering-sensitive interceptor tested | Concurrency-safe; fails closed | Library code that breaks ALS (rare) must be wrapped | Third-party callbacks | 3/4 → 1/4 | `tenant-context.test`, e2e mutation | ✅ |
| A6 | FK / unique existence oracles | Accept · generic errors only · **tenant-scoped keys + generic errors** | Composite FKs and tenant-leading unique indexes; driver detail never returned | No cross-tenant probing | Wider indexes (+16 bytes/entry) | Timing side channels (negligible) | 3/3 → 1/2 | `10` L3–L4, `errors.test` | ✅ |
| A7 | RLS bypass via owner / views / MVs / partitions / definer functions | Code review · **lint in CI** | Owner NOLOGIN + FORCE; views must be security_invoker; MVs banned; no partition grants; definer functions pin search_path, no PUBLIC execute | Structural regressions blocked | Some patterns (MVs) unavailable | Superuser (see C) | 3/5 → 1/5 | `10_schema_lint` | ✅ |
| A8 | Intra-firm leakage (competing clients) | Tenant-only RLS · app checks · **restrictive RLS walls** | Content visible to active members (or service); admins not exempt; self-staffing is chained in the audit log | Ethical walls enforced by the DB | Admin workflows need explicit membership | Admin adds self (detectable, not preventable) | 3/4 → 2/3 | `30` W1–W3 | ✅ |
| A9 | Client-portal users inside firm tenant | Separate portal tenant · **client flag + walls** | Clients see only their engagement, client, own uploads; never workpapers/TB/AJEs/COA/audit log | Portal isolation in the DB | Portal features need explicit policy per table | New table forgets client wall (lint candidate) | 4/5 → 1/5 | `30` W4 | ✅ |
| A10 | Cache / object store / presign leakage | Convention · **context-derived keys** | `TenantCache` (per-user default, hash-tagged), `TenantObjectStore` (server-generated keys, per-tenant KMS, TTL ≤ 300 s) + DB prefix CHECK | Leaks require bypassing both app and DB | Lower cache hit ratio (per-user scope) | Misuse of `'tenant'` scope for walled data | 3/4 → 1/3 | unit tests, `30` W4 | ✅ |
| A11 | Issuer confusion / tenant from headers | Tenant claim in JWT · header · **host → registered issuer** | Verify only against the tenant's registered issuer; resolve by `(tenant, iss, sub)`; unique issuer per tenant | Cross-IdP token replay impossible | Each tenant must register an IdP (or use platform Keycloak) | IdP compromise at a firm | 3/5 → 1/4 | `80_authn`, e2e | ✅ |
| A12 | Background jobs | Pass tenantId in payload · **sealed envelopes** | HMAC envelopes, expiry, no escalation, worker loop context-free | Queue write ≠ tenant takeover | Key management for a second key | Replay within TTL (idempotency keys in P2) | 3/4 → 1/3 | `job-envelope.test` | ✅ |

## B. Immutability, sign-off & ledger integrity

| # | Vulnerability | Options | Decision | Gain | Trade-off | Residual | L/I | Verified by | Status |
|---|---|---|---|---|---|---|---|---|---|
| B1 | Back-dating (client-supplied timestamps) | Trust client · app sets · **DB triggers** | `clock_timestamp()` overwrites all record-time columns | No back-dating via any client | Business "effective dates" modelled separately and validated (AJE in period) | DB clock integrity (NTP; RDS managed) | 4/4 → 1/3 | S1, J2, G3 | ✅ |
| B2 | Edit after approval | Lock flag · **append-only versions + content-hash sign-offs** | New version resets status; sign-offs bind `(version, sha256)` | "Approved" always means "this exact content" | Storage per version (content hashes chained, bodies not duplicated in events) | — | 4/5 → 1/4 | S1, S7 | ✅ |
| B3 | Self-review, level skipping, impersonation | App checks · **DB rules** | Order, SoD, rank, partner-only, forced signer | Enforced for every client and service | Small firms with 2 people need a documented exception process | Collusion between two users | 3/4 → 2/3 | S2–S9 | ✅ |
| B4 | Step-up authentication for sign-off | Password re-prompt · **WebAuthn** | DB requires an assertion for reviewer/partner; server-side verification in P2 | Phishing-resistant approval | Hardware/platform authenticators needed | **Until P2, the DB checks presence, not validity** | 3/4 → 2/4 (→1/4 in P2) | S4 | ◐ |
| B5 | AJE manipulation | Free-form journal · **state machine** | Maker-checker, balanced, in-period, stage-bound, immutable when posted, exact reversal, gapless numbers, PAJE never posted | ISA 450 summary and FS always reconcile | Stricter workflow for users | Collusion (preparer + approver) | 4/5 → 2/3 | `50_*` | ✅ |
| B6 | Post-archive tampering through the app | Soft lock · **DB archive lock** | `archived` engagement refuses every write path | ISA 230.14–16 aligned | Addendum workflow needed (P2) | — | 3/5 → 1/4 | G4 | ✅ |
| B7 | `TRUNCATE` / DDL by privileged users | Row triggers only · **+ statement triggers, no grants, pgaudit** | TRUNCATE guards; DDL logged to log-archive | Closes a classic gap | — | Superuser disables triggers → see B8 | 3/5 → 2/4 | S10, C6 | ◐ (pgaudit ☐ IaC) |
| B8 | DBA rewrites history | QLDB (EOL) · blockchain · **hash chain + external anchor** | Per-tenant SHA-256 chain via definer trigger; anchors signed with KMS into Object Lock COMPLIANCE in a separate account | Undetected tampering needs the anchor account + KMS key + DB | Anchoring job and second account to operate; chain serializes audited writes per tenant | Tampering between the last anchor and detection (anchor every ≤ 5 min) | 2/5 → 1/3 | C3–C5 | ◐ (detection ✅, job ☐ P2) |
| B9 | TB lines edited post-import | Audit every line · **digest** | `lines_sha256` fixed at import, re-verified at lock (the digest itself is chained) | Low write amplification | Detection at lock/verify time rather than instantly | — | 3/4 → 1/3 | M5 | ✅ |

## C. AI & ingestion

| # | Vulnerability | Options | Decision | Gain | Trade-off | Residual | L/I | Verified by | Status |
|---|---|---|---|---|---|---|---|---|---|
| C1 | Macro / DDE / XXE / zip bombs | Parse in API · **isolated sandbox** | No-egress sandbox, xlsx/csv only, cached values only, limits, malware scan | RCE contained to a disposable worker | Extra infra and latency (~seconds) | 0-day in parser libs | 3/5 → 1/3 | P3 fuzz corpus | ☐ P3 |
| C2 | Parser returns wrong or partial data | Trust parser · **control totals re-verified in DB** | Line count, ΣDr, ΣCr reconciled before import closes | Silent truncation impossible | Parser must compute totals independently of rows | Consistent-but-wrong source file | 3/4 → 1/3 | I1 | ✅ |
| C3 | Prompt injection in account names | Filter prompts · **no-authority AI** | Enum-constrained output; no tools; humans must decide; DB forbids service acceptance and edited suggestions | Injection can at worst produce a *wrong suggestion* a human sees flagged | Human review effort (mitigated by the cascade and bulk UX) | Reviewer rubber-stamping (monitor accept-rate, sampling QA) | 4/4 → 2/2 | M1–M3 | ◐ (DB ✅, model service ☐ P3) |
| C4 | Cross-tenant AI leakage | Shared index · **per-tenant namespaces** | Per-tenant embeddings/few-shots; public taxonomy only is shared; zero-retention provider | No other firm's mappings in prompts | Cold start for new firms (taxonomy helps) | Provider breach | 3/4 → 1/3 | P3 tests | ☐ P3 |
| C5 | Bidi / homoglyph spoofing | Ignore · **normalize + keep verbatim** | NFKC, bidi stripping, Arabic folding for matching; verbatim for display with a visible control-char badge | What reviewers approve is what's stored | Normalizer maintenance | New Unicode tricks | 3/3 → 1/2 | P3 golden tests | ◐ (schema ✅) |
| C6 | Formula injection on export | Ignore · **escape on export** | Prefix dangerous leading characters | Protects auditors' desktops | Slight data transformation on export | — | 3/3 → 1/2 | P4 tests | ☐ P4 |

## D. Residency, keys, compliance

| # | Gap | Options | Decision | Gain | Trade-off | Residual | Status |
|---|---|---|---|---|---|---|---|
| D1 | No hyperscale region in Jordan | Refuse regulated clients · regional only · **regional + sovereign cell + XKS** | Portable core; sovereign cell in P6; XKS for in-country keys meanwhile | Serve banks/government clients | Operating a second platform flavour | Local DC maturity | ◐ |
| D2 | Region pinning | Trust ops · **enforce in app** | Guard refuses tenants homed in another region (421) | Mis-routing cannot move data across borders | Cross-region DR must respect residency | — | ✅ |
| D3 | Per-tenant crypto | Shared key · **per-tenant CMK** | S3 SSE-KMS per tenant now; column envelope encryption P2; silo RDS CMK | Crypto-shredding, blast-radius reduction | KMS cost/limits at scale (bucket keys enabled) | — | ◐ |
| D4 | Retention vs erasure (PDPL) | Delete on request · **retention-aware** | Retention floor from tenant settings (default 10 y) + Object Lock; erasure after retention via crypto-shredding | Satisfies both audit law and PDPL | DSAR responses must explain legal-obligation basis | Jurisdictional conflicts → counsel | ✅ (floor) / ☐ (shredding) |
| D5 | LLM cross-border transfer | Any endpoint · **region-pinned or self-hosted** | Endpoint chosen per tenant residency policy | PDPL transfer compliance | Model choice constrained per region | — | ☐ P3 |

## E. Performance trade-offs of the security design

| Mechanism | Cost measured / expected | Mitigation |
|---|---|---|
| Signed context | 1 HMAC per statement (InitPlan, verified in `EXPLAIN`) | TTL 60 s; key cached by PG buffer |
| Ethical-wall RLS | Hashed SubPlan over `engagement_members_user_ix` (verified in `EXPLAIN`) | Partial index `WHERE removed_at IS NULL` |
| Composite keys | +16 bytes per index entry | Worth it; `tenant_id` prefix also gives locality |
| Hash chain | Serializes audited writes per tenant until commit | Audited tables are low-volume; TB lines use a digest; per-engagement chains if contention appears |
| Partitioned TB lines | Runtime partition pruning by `tenant_id` param | Hash partitioning by tenant (8 → 64 as data grows) |
| Transaction per request | +2 round trips (BEGIN, enter_context) | Same connection; read-only transactions for GETs |
