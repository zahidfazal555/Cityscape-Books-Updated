import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
export const E2E_DB = 'csd_e2e';
const admin =
  process.env['TEST_ADMIN_URL'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const appUrl = (() => {
  const u = new URL(admin);
  u.username = 'csd_app_login';
  u.password = 'app';
  u.pathname = `/${E2E_DB}`;
  return u.toString();
})();

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: process.env['PW_CHROMIUM_PATH']
      ? { executablePath: process.env['PW_CHROMIUM_PATH'] }
      : {},
  },
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    // The server starts before globalSetup creates the database, so wait on a page that needs none.
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: 'production',
      DATABASE_URL: appUrl,
      JWT_SECRET: Buffer.from('e2e-only-secret-not-for-production-use!!').toString('base64'),
      APP_URL: `http://localhost:${PORT}`,
      TRUSTED_PROXIES: '0',
      MAIL_MODE: 'outbox',
      CSD_ALLOW_OUTBOX_IN_PRODUCTION: 'e2e',
    },
  },
});
