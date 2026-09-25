# Audit platform web client

The reviewer's interface for Phase 3 trial-balance import and mapping. Next.js 16 (App Router), React 19, TypeScript. English and Arabic (right to left).

## What it does

- **Engagements** lists the engagements the signed-in user is staffed on. The database's ethical walls decide the list; the UI only renders it.
- **Trial balance**:
  - upload an `.xlsx`/`.csv`, then watch it go from *Queued* to *Processing* to *Imported* (or *Rejected*, with the parser's reason);
  - the newest import opens by itself once it has been parsed.
- **Review**:
  - every line shows the client's account name with the suggested firm account, where the suggestion came from (carried forward, firm rule, exact name, AI), its rationale and any flags;
  - the default filter is *Open* (not yet accepted);
  - **Bulk accept** covers only unflagged suggestions. Flagged ones (instruction-like text, a sign that disagrees with the account's normal balance, low confidence, concentration) must be accepted one by one after an explicit acknowledgement, or mapped by hand;
  - **Manual mapping** searches the firm's postable accounts and needs a reason, which goes into the audit trail;
  - **Lock**: the server decides who may lock (rank) and when (balanced, every line human-accepted, digest intact). The UI shows its refusal verbatim.

## Security choices

| Concern | Choice |
|---|---|
| Tokens | OIDC authorization code + PKCE (`oidc-client-ts`). Tokens are kept **in memory only** (no localStorage/sessionStorage); a reload signs in again. The post-login `returnTo` must be a same-origin path. |
| Sign-out and no-access | Sign-out also ends the session at the firm's IdP (RP-initiated logout), so the next person on a shared computer is not signed straight back in. The API answers an unprovisioned account exactly like a bad token, to prevent account probing. The browser therefore detects a rejection that comes immediately after a successful sign-in, and shows "no access to this firm" with "Use a different account". |
| Login discovery | `GET /api/auth/config` returns the tenant's own issuer and public web client id, resolved from the `Host` (`V0011`). Tenants are never enumerable from the browser. |
| Client-supplied text | Account names are untrusted: React text nodes only (no `dangerouslySetInnerHTML`), wrapped in `<bdi dir="auto">` so Arabic/Latin/bidi controls cannot reorder surrounding UI. |
| CSP | `proxy.ts` issues a fresh nonce per request: `script-src 'self' 'nonce-…' 'strict-dynamic'`, nonce-only `style-src`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `connect-src` limited to the app and its IdPs. `unsafe-eval` and `style-src 'unsafe-inline'` are added **only** under `next dev`. Pages render dynamically so every response carries its own nonce. |
| Headers | `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`, a restrictive `Permissions-Policy`, and no `X-Powered-By`. |
| Amounts | Decimal strings from the API are formatted with string arithmetic. They are never converted to `Number`. Debits and credits are shown in separate columns. |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_AUTH_MODE` | `oidc` | `dev-token` shows a paste-a-token form instead of OIDC login (development and browser tests only) |
| `NEXT_PUBLIC_API_BASE` | `/api` | API path prefix as seen by the browser |
| `AUTH_CONNECT_SRC` | unset | Space-separated IdP origins added to `connect-src` (token and discovery endpoints) |
| `API_ORIGIN` | unset | If set, `/api/*` is rewritten to this origin (local development). In production the edge routes `/api` to the API. |

## Scripts

```bash
npm run dev              # :3001
npm run typecheck        # next typegen + tsc
npm test                 # vitest + Testing Library (jsdom)
npm run test:e2e         # Playwright: production build on :3101, dev-token mode, mocked API
npm run test:idp         # Playwright: real OIDC sign-in via Keycloak + the real API and test DB (see playwright.idp.config.ts)
npm run smoke:fullstack  # manual: drives the real API from backend `npm run dev:stack` (see script header)
```

`PW_CHROMIUM_PATH=/path/to/chromium` makes Playwright use a pre-installed browser.

The browser tests check the following:

- the whole upload → review → map → lock flow runs with **zero CSP violations**;
- a hostile account name (`<img onerror=…>` plus injected instructions) stays inert;
- each request gets a new nonce;
- Arabic RTL works, and the language choice survives a reload while the token does not.
