#!/usr/bin/env node
/**
 * LOCAL DEVELOPMENT ONLY: run the API against a database created with
 *   KEEP_DB=1 ADMIN_URL=... ../db/scripts/test.sh
 * and a throwaway signing key instead of the firms' real IdPs.
 *
 *   DATABASE_URL=postgresql://audit_app_it:it-only@localhost:5432/<db> \
 *   ADMIN_DATABASE_URL=postgresql://postgres@localhost:5432/<db> npm run dev:stack
 *
 * (ADMIN_DATABASE_URL is optional: it registers development issuers for the
 * fixture tenants that have none.)
 *
 * - API on http://127.0.0.1:3000, tenants addressed as <slug>.localhost
 *   (the web app proxies /api here; open http://alpha-audit.localhost:3001).
 * - Token helper on http://127.0.0.1:3999/token?tenant=alpha-audit&sub=idp|alpha-junior
 *   returns a 1-hour access token for that fixture user, signed with a key
 *   generated at start-up. Paste it into the web app's development sign-in.
 *
 * Refuses to start with NODE_ENV=production, and binds to loopback only.
 */
import 'reflect-metadata';
import http from 'node:http';
import { NestFactory } from '@nestjs/core';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import { AppModule } from '../dist/app.module.js';
import { loadConfig } from '../dist/config/config.js';
import { JoseOidcVerifier } from '../dist/tenancy/token-verifier.js';

if (process.env.NODE_ENV === 'production') {
  console.error('dev-stack is for local development only.');
  process.exit(1);
}

const env = {
  CTX_SIGNING_KEY_ID: 'test-k1',
  CTX_SIGNING_KEY: 'test-only-hmac-key-0123456789abcdef-0123456789',   // matches db/tests/00_fixtures.sql
  JOB_ENVELOPE_KEY: 'dev-job-envelope-key-0123456789abcdef-0123',
  OIDC_AUDIENCE: 'audit-platform-api',
  TENANT_BASE_DOMAIN: 'localhost',
  DEPLOYMENT_REGION: 'me-central-1',
  PORT: '3000',
  ...process.env,
  NODE_ENV: 'development',
};
const config = loadConfig(env);
const tokenPort = Number(env.DEV_TOKEN_PORT ?? 3999);

const { privateKey, publicKey } = await generateKeyPair('ES256');
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'dev', alg: 'ES256' }] });
const verifier = new JoseOidcVerifier(config.OIDC_AUDIENCE, () => jwks);

const app = await NestFactory.create(AppModule.forRoot(config, { tokenVerifier: verifier }), { logger: ['error', 'warn', 'log'] });
const express = app.getHttpAdapter().getInstance();
express.set('trust proxy', 'loopback');   // the Next.js dev proxy forwards X-Forwarded-Host
express.disable('x-powered-by');
await app.listen(config.PORT, '127.0.0.1');

// Fixture tenants have no IdP registered; with an admin URL, give them dev issuers.
if (env.ADMIN_DATABASE_URL) {
  const admin = new pg.Client({ connectionString: env.ADMIN_DATABASE_URL });
  await admin.connect();
  await admin.query(`UPDATE platform.tenants SET oidc_issuer = 'https://login.' || split_part(slug, '-', 1) || '.test/'
                      WHERE oidc_issuer IS NULL`);
  await admin.end();
}

const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 });
http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(body); };
  if (url.pathname !== '/token') return send(404, 'GET /token?tenant=<slug>&sub=<idp subject>\n');
  const tenant = url.searchParams.get('tenant') ?? '';
  const sub = url.searchParams.get('sub') ?? '';
  const { rows } = await pool.query('SELECT oidc_issuer FROM platform.tenant_directory($1)', [tenant]);
  const issuer = rows[0]?.oidc_issuer;
  if (!issuer || !sub) return send(400, 'unknown tenant or missing sub (does the tenant have an oidc_issuer?)\n');
  const token = await new SignJWT({ amr: ['pwd', 'mfa'] })
    .setProtectedHeader({ alg: 'ES256', kid: 'dev' })
    .setIssuer(issuer).setSubject(sub).setAudience(config.OIDC_AUDIENCE)
    .setIssuedAt().setExpirationTime('1h').sign(privateKey);
  send(200, `${token}\n`);
}).listen(tokenPort, '127.0.0.1');

console.log(`API        http://127.0.0.1:${config.PORT}  (tenants: <slug>.localhost)`);
console.log(`Tokens     http://127.0.0.1:${tokenPort}/token?tenant=alpha-audit&sub=idp|alpha-junior`);
console.log('Web        cd ../web && API_ORIGIN=http://127.0.0.1:3000 NEXT_PUBLIC_AUTH_MODE=dev-token npm run dev');
console.log('           then open http://alpha-audit.localhost:3001');
