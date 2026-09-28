/**
 * Smoke test for the hosted demo (deploy/demo): real sign-in through the demo
 * Keycloak, the engagements list, a sample TB upload and the review screen.
 *
 *   DEMO_URL=https://jordan-audit.demo.example DEMO_USER=senior DEMO_PASSWORD=... \
 *   node scripts/demo-smoke.mjs
 * Screenshots go to $SHOTS (default test-results/demo). DEMO_INSECURE_TLS=1 is
 * for the local "localhost" profile only (Caddy's internal CA).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const BASE = process.env.DEMO_URL ?? 'https://jordan-audit.localhost';
const USER = process.env.DEMO_USER ?? 'senior';
const PASSWORD = process.env.DEMO_PASSWORD ?? '';
const SHOTS = process.env.SHOTS ?? 'test-results/demo';
const samples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deploy/demo/sample-tbs');
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, ignoreHTTPSErrors: process.env.DEMO_INSECURE_TLS === '1' });
const page = await context.newPage();
const csp = [];
page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });

await page.goto(`${BASE}/`);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.locator('#username').fill(USER);
await page.locator('#password').fill(PASSWORD);
await page.locator('#kc-login').click();
await page.getByRole('heading', { name: 'Engagements' }).waitFor({ timeout: 30_000 });
await page.screenshot({ path: `${SHOTS}/1-engagements.png` });
console.log('signed in as', await page.locator('.who').textContent());

await page.getByRole('link', { name: 'Trial balance' }).first().click();
await page.getByTestId('tb-file').setInputFiles(path.join(samples, 'Al-Nakheel Trading - TB 31-12-2025.xlsx'));
await page.getByRole('heading', { name: /Trial balance v\d/ }).waitFor({ timeout: 120_000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${SHOTS}/2-review.png`, fullPage: true });
console.log('progress:', await page.getByText(/of \d+ lines accepted/).first().textContent());

await page.getByRole('button', { name: 'العربية' }).click();
await page.locator('html[dir="rtl"]').waitFor();
await page.screenshot({ path: `${SHOTS}/3-review-arabic.png`, fullPage: true });
console.log('csp violations:', csp.length);
await browser.close();
