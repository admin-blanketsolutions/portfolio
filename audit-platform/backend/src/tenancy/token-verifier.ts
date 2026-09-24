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

/**
 * OIDC access-token verification with `jose`.
 *  - The issuer comes from OUR tenant directory, never from the token, so
 *    JWKS is only fetched from registered issuers (no SSRF via `iss`).
 *  - Algorithms are pinned (no `none`, no HS* key-confusion).
 *  - Audience is pinned to this API.
 */
export class JoseOidcVerifier implements TokenVerifier {
  private readonly jwks = new Map<string, JWTVerifyGetKey>();

  constructor(
    private readonly audience: string,
    private readonly keySetFor: (issuer: string) => JWTVerifyGetKey = (issuer) =>
      createRemoteJWKSet(new URL('.well-known/jwks.json', issuer.endsWith('/') ? issuer : `${issuer}/`), {
        timeoutDuration: 3_000,
        cooldownDuration: 30_000,
      }),
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
