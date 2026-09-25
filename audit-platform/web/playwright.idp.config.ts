import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/*
 * Sign-in against a REAL identity provider (Keycloak), the real API and a
 * migrated test database: no mocks and no development tokens.
 *
 * Prerequisites (CI does the same):
 *   ../idp/keycloak/start-test-idp.sh "$TEST_IDP_DIR"   # https://localhost:8443
 *   KEEP_DB=1 ../db/scripts/test.sh                      # fixtures
 *   (cd ../backend && npm run build)
 * Environment: TEST_IDP_DIR, ADMIN_DATABASE_URL, DATABASE_URL.
 */
const idpDir = process.env.TEST_IDP_DIR ?? '/tmp/audit-test-idp';
const executablePath = process.env.PW_CHROMIUM_PATH;

// Trust ONLY the throwaway IdP's certificate (by public-key pin), not "any certificate".
const spki = (() => {
  try {
    const der = new X509Certificate(readFileSync(path.join(idpDir, 'tls.crt'))).publicKey.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(der).digest('base64');
  } catch {
    return '';
  }
})();

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../backend');
const apiEnv: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL ?? '',
  CTX_SIGNING_KEY_ID: 'test-k1',
  CTX_SIGNING_KEY: 'test-only-hmac-key-0123456789abcdef-0123456789',   // matches db/tests/00_fixtures.sql
  JOB_ENVELOPE_KEY: 'test-only-job-envelope-key-0123456789abcdef',
  OIDC_AUDIENCE: 'audit-platform-api',
  TENANT_BASE_DOMAIN: 'localhost',
  DEPLOYMENT_REGION: 'me-central-1',
  // The API verifies tokens with keys fetched from the IdP over TLS.
  NODE_EXTRA_CA_CERTS: path.join(idpDir, 'ca.pem'),
};

export default defineConfig({
  testDir: 'tests/idp',
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : [],
    },
  },
  webServer: [
    {
      command: `node ${backend}/scripts/link-test-idp.mjs && node ${backend}/dist/main.js`,
      url: 'http://127.0.0.1:3000/health/live',
      timeout: 60_000,
      reuseExistingServer: false,
      env: apiEnv,
    },
    {
      command: 'npm run build && npx next start --port 3101 --hostname 127.0.0.1',
      url: 'http://127.0.0.1:3101',
      timeout: 240_000,
      reuseExistingServer: false,
      env: {
        NEXT_DIST_DIR: '.next-idp',
        NEXT_PUBLIC_API_BASE: '/api',
        API_ORIGIN: 'http://127.0.0.1:3000',
        AUTH_CONNECT_SRC: 'https://localhost:8443',
      },
    },
  ],
});
