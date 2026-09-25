import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  /** Authentication methods (e.g. ["pwd","mfa"] / ["hwk"]); drives step-up checks. */
  amr: string[];
  authTime?: number;
}

export interface TokenVerifier {
  /** Verify `token` strictly against `expectedIssuer` (the tenant's registered IdP). */
  verify(token: string, expectedIssuer: string): Promise<VerifiedIdentity>;
}

export class TokenRejectedError extends Error {
  constructor() {
    super('token rejected');
    this.name = 'TokenRejectedError';
  }
}

export class OidcDiscoveryError extends Error {
  constructor(reason: string) {
    super(`OIDC discovery failed: ${reason}`);
    this.name = 'OidcDiscoveryError';
  }
}

type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

/**
 * Finds an issuer's signing-key endpoint through OpenID Connect Discovery.
 * IdPs publish keys at different paths (Keycloak .../protocol/openid-connect/certs,
 * Entra ID .../discovery/v2.0/keys, Okta .../v1/keys), so the path is read from
 * the issuer's metadata rather than guessed. The metadata must name exactly the
 * issuer we asked about (OIDC Discovery 4.3), both URLs must be https, and
 * redirects are refused.
 */
export async function discoverJwksUri(issuer: string, fetchImpl: FetchLike = fetch, timeoutMs = 3_000): Promise<URL> {
  const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  const url = new URL(`${base}/.well-known/openid-configuration`);
  if (url.protocol !== 'https:') throw new OidcDiscoveryError('issuer is not https');
  let doc: { issuer?: unknown; jwks_uri?: unknown };
  try {
    const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) throw new OidcDiscoveryError(`metadata returned ${res.status}`);
    const text = await res.text();
    if (text.length > 256 * 1024) throw new OidcDiscoveryError('metadata too large');
    doc = JSON.parse(text) as typeof doc;
  } catch (err) {
    throw err instanceof OidcDiscoveryError ? err : new OidcDiscoveryError('metadata unavailable');
  }
  if (doc.issuer !== issuer) throw new OidcDiscoveryError('metadata names a different issuer');
  if (typeof doc.jwks_uri !== 'string') throw new OidcDiscoveryError('metadata has no jwks_uri');
  const jwks = new URL(doc.jwks_uri);
  if (jwks.protocol !== 'https:') throw new OidcDiscoveryError('jwks_uri is not https');
  return jwks;
}

/**
 * Key resolver per issuer: discovery once, then jose's remote JWKS cache
 * (re-fetched on unknown `kid`, rate-limited). A failed discovery is retried
 * after a cool-down, not on every request.
 */
export function discoveredKeySet(fetchImpl: FetchLike = fetch, retryAfterMs = 30_000): (issuer: string) => JWTVerifyGetKey {
  return (issuer) => {
    let keys: Promise<JWTVerifyGetKey> | null = null;
    let failedAt = 0;
    return async (header, token) => {
      if (!keys || (failedAt && Date.now() - failedAt > retryAfterMs)) {
        failedAt = 0;
        keys = discoverJwksUri(issuer, fetchImpl).then(
          (uri) => createRemoteJWKSet(uri, { timeoutDuration: 3_000, cooldownDuration: 30_000 }),
          (err: unknown) => { failedAt = Date.now(); throw err; },
        );
      }
      return (await keys)(header, token);
    };
  };
}

/**
 * OIDC access-token verification with `jose`.
 *  - The issuer comes from OUR tenant directory, never from the token, so
 *    keys are only fetched from registered issuers (no SSRF via `iss`).
 *  - Algorithms are pinned (no `none`, no HS* key-confusion).
 *  - Audience is pinned to this API.
 */
export class JoseOidcVerifier implements TokenVerifier {
  private readonly jwks = new Map<string, JWTVerifyGetKey>();

  constructor(
    private readonly audience: string,
    private readonly keySetFor: (issuer: string) => JWTVerifyGetKey = discoveredKeySet(),
  ) {}

  async verify(token: string, expectedIssuer: string): Promise<VerifiedIdentity> {
    let keys = this.jwks.get(expectedIssuer);
    if (!keys) {
      keys = this.keySetFor(expectedIssuer);
      this.jwks.set(expectedIssuer, keys);
    }
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: expectedIssuer,
        audience: this.audience,
        algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'],
        clockTolerance: 30,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      const amr = Array.isArray(payload['amr']) ? payload['amr'].filter((x): x is string => typeof x === 'string') : [];
      const authTime = typeof payload['auth_time'] === 'number' ? payload['auth_time'] : undefined;
      return {
        issuer: expectedIssuer,
        subject: payload.sub as string,
        amr,
        ...(authTime !== undefined ? { authTime } : {}),
      };
    } catch {
      throw new TokenRejectedError();
    }
  }
}
