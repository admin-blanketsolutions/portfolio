import { defineConfig, devices } from '@playwright/test';

/*
 * Browser tests run the real Next.js app against a mocked API (page.route),
 * signed in with a development token. PW_CHROMIUM_PATH lets environments
 * with a pre-installed Chromium use it instead of downloading one.
 */
const executablePath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3101',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: 'npm run build && npx next start --port 3101 --hostname 127.0.0.1',
    url: 'http://127.0.0.1:3101',
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: { NEXT_PUBLIC_AUTH_MODE: 'dev-token', NEXT_PUBLIC_API_BASE: '/api' },
  },
});
