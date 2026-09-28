/**
 * Full demo walkthrough against the demo stack: upload -> review -> manual
 * mapping of the flagged lines -> lock -> financial statements (EN + AR).
 * Uses the small "Security demo" workbook so it needs no AI key.
 *
 *   DEMO_URL=... DEMO_PASSWORD=<senior's> node scripts/demo-walkthrough.mjs
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const BASE = process.env.DEMO_URL ?? 'https://jordan-audit.localhost';
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
await page.locator('#username').fill(process.env.DEMO_USER ?? 'senior');
await page.locator('#password').fill(process.env.DEMO_PASSWORD ?? '');
await page.locator('#kc-login').click();
await page.getByRole('heading', { name: 'Engagements' }).waitFor({ timeout: 30_000 });

await page.getByRole('link', { name: 'Trial balance' }).nth(Number(process.env.DEMO_ENGAGEMENT_INDEX ?? 2)).click();
await page.getByTestId('tb-file').setInputFiles(path.join(samples, 'Security demo - suspicious account names.xlsx'));
await page.getByRole('heading', { name: /Trial balance v\d/ }).waitFor({ timeout: 120_000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: `${SHOTS}/4-security-demo-review.png`, fullPage: true });

const bulk = page.getByLabel('Select all unflagged suggestions on this page');
if (await bulk.isEnabled()) {
  await bulk.check();
  await page.getByRole('button', { name: 'Accept selected' }).click();
  await page.getByText(/accepted, \d+ skipped/).waitFor();
}
const manual = { '1002': '1010', '1101': '1100', '2001': '2000', '4001': '4000', '5101': '5100', '5201': '5200', '3001': '3000' };
for (const [code, coa] of Object.entries(manual)) {
  const row = page.getByTestId(`line-${code}`);
  if (!(await row.count())) continue;          // already accepted from a suggestion
  await row.getByRole('button', { name: 'Map…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Map account manually' });
  await dlg.getByLabel('Search accounts (code or name)').fill(coa);
  await dlg.getByLabel(new RegExp(`^${coa}`)).check();
  await dlg.getByLabel('Reason (recorded in the audit trail)').fill('Mapped by the reviewer during the demo.');
  await dlg.getByRole('button', { name: 'Save mapping' }).click();
  await dlg.waitFor({ state: 'detached' });
}
await page.getByText(/(\d+) of \1 lines accepted/).waitFor();
await page.getByRole('button', { name: 'Lock trial balance' }).click();
await page.getByRole('dialog').getByRole('button', { name: 'Lock trial balance' }).click();
await page.getByText(/^Locked /).first().waitFor();

await page.getByRole('tab', { name: 'Financial statements' }).click();
await page.getByTestId('statement-bs').waitFor();
await page.screenshot({ path: `${SHOTS}/5-statements.png`, fullPage: true });
console.log('balance check:', await page.locator('.statements .pill').first().textContent());
await page.getByRole('button', { name: 'العربية' }).click();
await page.locator('html[dir="rtl"]').waitFor();
await page.screenshot({ path: `${SHOTS}/6-statements-arabic.png`, fullPage: true });
console.log('csp violations:', csp.length);
await browser.close();
