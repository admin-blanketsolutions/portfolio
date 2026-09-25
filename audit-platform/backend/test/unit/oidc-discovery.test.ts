import { describe, expect, it } from 'vitest';
import { discoverJwksUri, discoveredKeySet, OidcDiscoveryError } from '../../src/tenancy/token-verifier.js';

const ISS = 'https://login.example.com/realms/alpha';
const doc = (over: Record<string, unknown> = {}) => JSON.stringify({ issuer: ISS, jwks_uri: `${ISS}/protocol/openid-connect/certs`, ...over });

function fakeFetch(body: string, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (url: URL, init: RequestInit) => { calls.push({ url: url.href, init }); return new Response(body, { status }); };
  return Object.assign(fn, { calls });
}

describe('OIDC discovery', () => {
  it('reads the key endpoint from the issuer metadata, refusing redirects', async () => {
    const f = fakeFetch(doc());
    expect((await discoverJwksUri(ISS, f)).href).toBe(`${ISS}/protocol/openid-connect/certs`);
    expect(f.calls[0]!.url).toBe(`${ISS}/.well-known/openid-configuration`);
    expect(f.calls[0]!.init.redirect).toBe('error');
    // A trailing slash on the registered issuer does not double the separator.
    const g = fakeFetch(JSON.stringify({ issuer: `${ISS}/`, jwks_uri: `${ISS}/keys` }));
    await discoverJwksUri(`${ISS}/`, g);
    expect(g.calls[0]!.url).toBe(`${ISS}/.well-known/openid-configuration`);
  });

  it('rejects metadata that names another issuer (mix-up / substitution)', async () => {
    await expect(discoverJwksUri(ISS, fakeFetch(doc({ issuer: 'https://evil.example/realms/alpha' })))).rejects.toThrow(/different issuer/);
  });

  it('insists on https for the issuer and the key endpoint', async () => {
    await expect(discoverJwksUri('http://login.example.com/realms/alpha', fakeFetch(doc()))).rejects.toThrow(/issuer is not https/);
    await expect(discoverJwksUri(ISS, fakeFetch(doc({ jwks_uri: 'http://login.example.com/keys' })))).rejects.toThrow(/jwks_uri is not https/);
  });

  it('fails closed on errors, oversized or malformed metadata', async () => {
    await expect(discoverJwksUri(ISS, fakeFetch('nope', 500))).rejects.toBeInstanceOf(OidcDiscoveryError);
    await expect(discoverJwksUri(ISS, fakeFetch('{not json'))).rejects.toThrow(/unavailable/);
    await expect(discoverJwksUri(ISS, fakeFetch(`{"issuer":"${ISS}","x":"${'a'.repeat(300_000)}"}`))).rejects.toThrow(/too large/);
    await expect(discoverJwksUri(ISS, fakeFetch(JSON.stringify({ issuer: ISS })))).rejects.toThrow(/no jwks_uri/);
  });

  it('does not re-run a failed discovery on every request', async () => {
    const f = fakeFetch('down', 503);
    const keys = discoveredKeySet(f, 60_000)(ISS);
    await expect(keys({ alg: 'ES256' }, {} as never)).rejects.toBeInstanceOf(OidcDiscoveryError);
    await expect(keys({ alg: 'ES256' }, {} as never)).rejects.toBeInstanceOf(OidcDiscoveryError);
    expect(f.calls).toHaveLength(1);
  });
});
