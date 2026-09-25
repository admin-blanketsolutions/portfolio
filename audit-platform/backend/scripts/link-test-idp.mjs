/**
 * TEST ONLY: points the fixture tenants at the throwaway Keycloak started by
 * idp/keycloak/start-test-idp.sh, so the sign-in tests use real IdP-issued
 * tokens end to end. The test realms give their accounts the fixture users'
 * subjects (identity columns are immutable, so nothing is re-linked here).
 *
 *   ADMIN_DATABASE_URL=... node scripts/link-test-idp.mjs
 *
 * Refuses to run in production or against a database without the SQL test
 * fixtures.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') {
  console.error('link-test-idp is for test databases only.');
  process.exit(1);
}
const IDP = process.env.TEST_IDP_ORIGIN ?? 'https://localhost:8443';
const realmsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../idp/keycloak');

const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
await admin.connect();
try {
  const { rows } = await admin.query("SELECT to_regnamespace('test') IS NOT NULL AS fixtures");
  if (!rows[0].fixtures) throw new Error('no SQL test fixtures in this database; refusing to modify it');
  await admin.query('BEGIN');
  for (const slug of ['alpha-audit', 'beta-audit']) {
    const realm = JSON.parse(readFileSync(path.join(realmsDir, `realm-${slug}.json`), 'utf8'));
    const issuer = `${IDP}/realms/${realm.realm}`;
    const t = await admin.query('UPDATE platform.tenants SET oidc_issuer = $1 WHERE slug = $2 RETURNING id', [issuer, slug]);
    if (t.rowCount !== 1) throw new Error(`tenant ${slug} not found`);
    await admin.query('SELECT platform.set_web_client($1, $2)', [t.rows[0].id, realm.clients[0].clientId]);
    const linked = await admin.query('SELECT count(*)::int AS n FROM app.users WHERE tenant_id = $1 AND idp_subject = ANY($2)',
      [t.rows[0].id, realm.users.map((u) => u.id)]);
    // Accounts without a platform user (e.g. "outsider") stay unlinked on purpose.
    console.log(`${slug}: issuer ${issuer}; ${linked.rows[0].n} of ${realm.users.length} IdP accounts are platform users`);
  }
  await admin.query('COMMIT');
} finally {
  await admin.end();
}
