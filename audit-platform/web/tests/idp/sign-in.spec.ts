import { expect, test, type Page } from '@playwright/test';

/*
 * Real OIDC sign-in: browser -> firm's Keycloak realm (authorization code +
 * PKCE) -> web app -> API, which verifies the IdP-issued token itself.
 */
const IDP = 'https://localhost:8443';
const app = (tenant: string) => `http://${tenant}-audit.localhost:3101`;

interface Watch { tokens: string[]; csp: string[] }

function watch(page: Page): Watch {
  const w: Watch = { tokens: [], csp: [] };
  page.on('request', async (req) => {
    if (!req.url().includes('/api/')) return;
    const auth = (await req.allHeaders())['authorization'];   // headers() omits credentials
    if (auth?.startsWith('Bearer ')) w.tokens.push(auth.slice(7));
  });
  page.on('console', (msg) => { if (/Content Security Policy/i.test(msg.text())) w.csp.push(msg.text()); });
  return w;
}

async function signIn(page: Page, tenant: string, username: string) {
  await page.goto(`${app(tenant)}/`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${IDP}/realms/${tenant}-audit/protocol/openid-connect/auth**`);
  const authorize = new URL(page.url());
  expect(authorize.searchParams.get('client_id')).toBe('audit-web');
  expect(authorize.searchParams.get('response_type')).toBe('code');
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorize.searchParams.get('redirect_uri')).toBe(`${app(tenant)}/auth/callback`);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(`test-only-${tenant}-${username}`);
  await page.locator('#kc-login').click();
  await page.waitForURL(`${app(tenant)}/**`);
}

const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;

test('a firm user signs in through the firm\'s own IdP and the API accepts that token', async ({ page }) => {
  const w = watch(page);
  await signIn(page, 'alpha', 'senior');
  await expect(page.getByRole('heading', { name: 'Engagements' })).toBeVisible();
  await expect(page.getByText('Senior · alpha-audit')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Trial balance' }).first()).toBeVisible();

  // The API was called with the IdP's own access token, scoped to this API.
  const token = w.tokens.at(-1)!;
  const c = claims(token);
  expect(c['iss']).toBe(`${IDP}/realms/alpha-audit`);
  expect([c['aud']].flat()).toContain('audit-platform-api');
  expect(c['azp']).toBe('audit-web');
  expect(c['sub']).toBe('idp|alpha-senior');

  // Tokens live in memory only: nothing in web storage or cookies of the app origin.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }) + document.cookie);
  expect(stored).not.toContain(token);
  expect(stored).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
  expect(w.csp).toEqual([]);
});

test('a token from one firm\'s IdP is refused on another firm\'s host', async ({ page, context }) => {
  const w = watch(page);
  await signIn(page, 'alpha', 'senior');
  await expect(page.getByText('Senior · alpha-audit')).toBeVisible();
  const token = w.tokens.at(-1)!;
  // Same-origin calls from each firm's own host, as the browser would make them.
  const status = async (tenant: string, bearer: string) => {
    const p = tenant === 'alpha' ? page : await context.newPage();
    if (tenant !== 'alpha') await p.goto(`${app(tenant)}/`);
    return p.evaluate(async (b) => (await fetch('/api/me', { headers: { authorization: `Bearer ${b}` } })).status, bearer);
  };
  expect(await status('alpha', token)).toBe(200);
  expect(await status('beta', token)).toBe(401);
  // A token with a forged signature is refused even on the right host.
  const [h, p] = token.split('.');
  expect(await status('alpha', `${h}.${p}.${'A'.repeat(86)}`)).toBe(401);
});

test('each firm signs in against its own realm', async ({ page }) => {
  await signIn(page, 'beta', 'senior');
  await expect(page.getByText('Senior · beta-audit')).toBeVisible();
});

test('an IdP account that is not a platform user gets no access, and can switch accounts', async ({ page }) => {
  await signIn(page, 'alpha', 'outsider');
  await expect(page.getByRole('alert').filter({ hasText: 'no access to this firm' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Engagements' })).toHaveCount(0);
  // Switching ends the IdP session, so the login form appears instead of the same account.
  await page.getByRole('button', { name: 'Use a different account' }).click();
  await page.waitForURL(`${app('alpha')}/`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#password')).toBeVisible();
});

test('a reload forgets the token; the IdP session signs the user back in without a password', async ({ page }) => {
  await signIn(page, 'alpha', 'junior');
  await expect(page.getByText('Junior · alpha-audit')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Straight back: Keycloak's own session answers, no login form.
  await expect(page.getByText('Junior · alpha-audit')).toBeVisible();
  await expect(page.locator('#password')).toHaveCount(0);
});

test('signing out ends the session at the IdP as well', async ({ page }) => {
  await signIn(page, 'alpha', 'senior');
  await expect(page.getByText('Senior · alpha-audit')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(`${app('alpha')}/`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#password')).toBeVisible();          // no silent sign-in as the previous user
});
