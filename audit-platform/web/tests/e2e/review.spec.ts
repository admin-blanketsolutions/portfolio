import { expect, test, type Page } from '@playwright/test';
import { MockApi, TOKEN } from './mock-api';

const CSV = Buffer.from('Code,Account name,Debit,Credit\n101,Cash at bank,99500,\n', 'utf8');

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByTestId('dev-token').fill(TOKEN);
  await page.getByRole('button', { name: 'Use token' }).click();
  await expect(page.getByRole('heading', { name: 'Engagements' })).toBeVisible();
}

test('a reviewer uploads, reviews, maps and locks a trial balance', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  const cspViolations: string[] = [];
  page.on('console', (msg) => { if (/Content Security Policy/i.test(msg.text())) cspViolations.push(msg.text()); });

  await signIn(page);
  await expect(page.getByText('Senior · alpha-audit')).toBeVisible();
  await page.getByRole('link', { name: 'Trial balance' }).click();
  await expect(page.getByText('No trial balance has been uploaded yet.')).toBeVisible();

  // Upload -> queued/processing -> imported, then the review opens by itself.
  await page.getByTestId('tb-file').setInputFiles({ name: 'TB FY2025.csv', mimeType: 'text/csv', buffer: CSV });
  await expect(page.getByTestId('import-row').first()).toContainText(/Queued|Processing/);
  await expect(page.getByTestId('import-row').first()).toContainText('Imported', { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Trial balance v1 · as of 2025-12-31' })).toBeVisible();
  expect(api.uploads).toEqual([{ filename: 'TB FY2025.csv', contentType: 'text/csv', size: CSV.length }]);

  // The injected line is flagged, rendered as text, and excluded from bulk acceptance.
  const injected = page.getByTestId('line-401');
  await expect(injected).toContainText('<img src=x onerror=');
  await expect(injected.getByText('Instruction-like text').first()).toBeVisible();
  await expect(injected.getByRole('checkbox')).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator('.lines img').count()).toBe(0);

  await page.getByLabel('Select all unflagged suggestions on this page').check();
  await page.getByRole('button', { name: 'Accept selected' }).click();
  await expect(page.getByText('2 accepted, 0 skipped')).toBeVisible();
  await expect(page.getByText('2 of 3 lines accepted')).toBeVisible();

  // Locking with an open line is refused by the server; the reason is shown.
  await page.getByRole('button', { name: 'Lock trial balance' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Lock trial balance' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '1 line(s) have no human-accepted mapping' })).toBeVisible();

  // The flagged line needs an explicit acknowledgement; the reviewer maps it by hand instead.
  await injected.getByRole('button', { name: 'Accept' }).click();
  const ackDialog = page.getByRole('dialog', { name: 'Accept a flagged suggestion' });
  await expect(ackDialog.getByRole('button', { name: 'Accept suggestion' })).toBeDisabled();
  await ackDialog.getByRole('button', { name: 'Cancel' }).click();

  await injected.getByRole('button', { name: 'Map…' }).click();
  const mapDialog = page.getByRole('dialog', { name: 'Map account manually' });
  await mapDialog.getByLabel('Search accounts (code or name)').fill('rev');
  await mapDialog.getByLabel(/4000/).check();
  await mapDialog.getByLabel('Reason (recorded in the audit trail)').fill('Revenue; the name carried injected instructions.');
  await mapDialog.getByRole('button', { name: 'Save mapping' }).click();
  await expect(page.getByText('3 of 3 lines accepted')).toBeVisible();

  await page.getByRole('tab', { name: 'Accepted' }).click();
  await expect(page.getByTestId('line-401')).toContainText('Manual');

  await page.getByRole('button', { name: 'Lock trial balance' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Lock trial balance' }).click();
  await expect(page.getByText(/^Locked /)).toHaveCount(1);                           // one status notice, no duplicate
  await expect(page.getByRole('button', { name: 'Accept' })).toHaveCount(0);        // read-only once locked
  expect(dialogs).toEqual([]);
  expect(cspViolations).toEqual([]);                                                // the app runs under the strict policy
});

test('parser rejections are explained on the upload', async ({ page }) => {
  const api = new MockApi();
  api.failNextUpload = 'Could not find a header row with an account code, an account name and balance columns.';
  await api.install(page);
  await signIn(page);
  await page.getByRole('link', { name: 'Trial balance' }).click();
  await page.getByTestId('tb-file').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('foo,bar\n') });
  await expect(page.getByTestId('import-row').first()).toContainText('Rejected', { timeout: 15_000 });
  await expect(page.getByRole('alert').filter({ hasText: 'Could not find a header row' })).toBeVisible();
});

test('the interface switches to Arabic, right to left', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await signIn(page);
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { name: 'المهام' })).toBeVisible();
  await expect(page.getByText('المدقق الأول · alpha-audit')).toBeVisible();
  // The choice persists; the token does not (memory only), so a reload asks to sign in again, in Arabic.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('button', { name: 'استخدام الرمز' })).toBeVisible();
});

test('pages are served with a restrictive security policy', async ({ page }) => {
  const res = await page.goto('/');
  const headers = res!.headers();
  const csp = headers['content-security-policy']!;
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).toContain("frame-ancestors 'none'");
  const again = (await page.request.get('/')).headers()['content-security-policy'];
  expect(again).not.toBe(csp);                                                     // fresh nonce per request
  expect(csp).toContain("object-src 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-powered-by']).toBeUndefined();
});
