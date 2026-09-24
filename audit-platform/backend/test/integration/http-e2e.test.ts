import 'reflect-metadata';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { JoseOidcVerifier } from '../../src/tenancy/token-verifier.js';
import { enabled, loadFixture, testConfig, type Fixture } from './env.js';

const AUD = 'audit-platform-api';
const ISS = { alpha: 'https://login.alpha.test/', beta: 'https://login.beta.test/' } as const;

interface Res { status: number; body: any }

describe.skipIf(!enabled)('HTTP end-to-end: host -> OIDC -> principal -> ALS -> RLS', () => {
  let app: INestApplication;
  let port: number;
  let fx: Fixture;
  const keys: Record<string, { priv: CryptoKey; jwk: JWK }> = {};

  const token = async (tenant: 'alpha' | 'beta', subject: string, opts: { signWith?: 'alpha' | 'beta'; aud?: string } = {}) =>
    new SignJWT({ amr: ['pwd', 'mfa'] })
      .setProtectedHeader({ alg: 'ES256', kid: opts.signWith ?? tenant })
      .setIssuer(ISS[tenant]).setSubject(subject).setAudience(opts.aud ?? AUD)
      .setIssuedAt().setExpirationTime('5m')
      .sign(keys[opts.signWith ?? tenant]!.priv);

  const call = (method: string, path: string, host: string, bearer?: string, body?: unknown) =>
    new Promise<Res>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, method, path,
        headers: {
          host,
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  beforeAll(async () => {
    fx = await loadFixture();
    for (const t of ['alpha', 'beta'] as const) {
      const { privateKey, publicKey } = await generateKeyPair('ES256');
      keys[t] = { priv: privateKey, jwk: { ...(await exportJWK(publicKey)), kid: t, alg: 'ES256' } };
    }
    // Each issuer has its own JWKS, exactly like two independent IdPs.
    const verifier = new JoseOidcVerifier(AUD, (issuer) =>
      createLocalJWKSet({ keys: [issuer === ISS.alpha ? keys.alpha!.jwk : keys.beta!.jwk] }));
    app = await NestFactory.create(AppModule.forRoot(testConfig(), { tokenVerifier: verifier }), { logger: false });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => { await app?.close(); });

  it('serves each tenant only its own data', async () => {
    const a = await call('GET', '/engagements', 'alpha-audit.app.test', await token('alpha', 'idp|alpha-manager'));
    expect(a.status).toBe(200);
    expect(a.body.engagements.map((e: { code: string }) => e.code).sort()).toEqual(['ENG-A', 'ENG-WALL']);
    const b = await call('GET', '/engagements', 'beta-audit.app.test', await token('beta', 'idp|beta-manager'));
    expect(b.body.engagements.map((e: { code: string }) => e.code)).toEqual(['ENG-B']);
  });

  it('keeps 40 concurrent interleaved requests from two tenants isolated', async () => {
    const [ta, tb] = await Promise.all([token('alpha', 'idp|alpha-client'), token('beta', 'idp|beta-client')]);
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? call('GET', '/engagements', 'alpha-audit.app.test', ta).then((r) => ({ want: ['ENG-A'], r }))
        : call('GET', '/engagements', 'beta-audit.app.test', tb).then((r) => ({ want: ['ENG-B'], r }))));
    for (const { want, r } of results) {
      expect(r.status).toBe(200);
      expect(r.body.engagements.map((e: { code: string }) => e.code)).toEqual(want);
    }
  });

  it('rejects issuer confusion: a valid beta token presented to the alpha host', async () => {
    const r = await call('GET', '/engagements', 'alpha-audit.app.test', await token('beta', 'idp|beta-manager'));
    expect(r.status).toBe(401);
  });

  it('rejects a token claiming alpha\'s issuer but signed with beta\'s key', async () => {
    const r = await call('GET', '/engagements', 'alpha-audit.app.test', await token('alpha', 'idp|alpha-manager', { signWith: 'beta' }));
    expect(r.status).toBe(401);
  });

  it('rejects wrong audience, unsigned tokens and missing credentials', async () => {
    const wrongAud = await token('alpha', 'idp|alpha-manager', { aud: 'some-other-api' });
    expect((await call('GET', '/engagements', 'alpha-audit.app.test', wrongAud)).status).toBe(401);
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: ISS.alpha, sub: 'idp|alpha-admin', aud: AUD, exp: 4e9, iat: 1 })).toString('base64url')}.`;
    expect((await call('GET', '/engagements', 'alpha-audit.app.test', none)).status).toBe(401);
    expect((await call('GET', '/engagements', 'alpha-audit.app.test')).status).toBe(401);
  });

  it('gives unknown tenants and unknown users indistinguishable answers', async () => {
    const unknownTenant = await call('GET', '/engagements', 'nope-audit.app.test', await token('alpha', 'idp|alpha-manager'));
    expect(unknownTenant.status).toBe(404);
    const unknownUser = await call('GET', '/engagements', 'alpha-audit.app.test', await token('alpha', 'idp|ghost'));
    expect(unknownUser.status).toBe(401);
    expect(unknownUser.body.message).toBe('Authentication required.');
  });

  it('treats another tenant\'s engagement id as non-existent, and enforces ethical walls', async () => {
    const mgr = await token('alpha', 'idp|alpha-manager');
    const foreign = await call('POST', `/engagements/${fx.engagements['ENG-B']}/stage`, 'alpha-audit.app.test', mgr, { stage: 'review' });
    expect(foreign.status).toBe(404);
    const junior = await token('alpha', 'idp|alpha-junior');
    const walled = await call('POST', `/engagements/${fx.engagements['ENG-WALL']}/stage`, 'alpha-audit.app.test', junior, { stage: 'fieldwork' });
    expect(walled.status).toBe(403);
    expect(JSON.stringify(walled.body)).not.toMatch(/tenant_id|SQLSTATE|violates/);
  });

  it('keeps health endpoints public and tenant-neutral', async () => {
    expect((await call('GET', '/health/live', 'anything.example')).status).toBe(200);
    expect((await call('GET', '/health/ready', 'anything.example')).status).toBe(200);
  });
});
