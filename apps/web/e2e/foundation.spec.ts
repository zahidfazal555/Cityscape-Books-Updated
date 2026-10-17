import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, email } from './fixtures';

async function signIn(page: Page, role: Parameters<typeof email>[0]) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email(role));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good');
}

test('sign-in page: wrong password gets the generic message; no CSP violations', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  const res = await page.goto('/login');
  expect(res?.headers()['content-security-policy']).toMatch(
    /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
  );
  expect(res?.headers()['x-frame-options']).toBe('DENY');
  await page.getByLabel('Work email').fill(email('owner'));
  await page.getByLabel('Password').fill('wrong-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Email or password' })).toHaveText(
    /Email or password is incorrect/,
  );
  expect(violations).toEqual([]);
});

test('owner signs in, sees Users & security and the lock date; sign out returns to sign-in', async ({
  page,
}) => {
  await signIn(page, 'owner');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toContainText('Users & security');
  await expect(nav).toContainText('Books locked till 30 Sep 2026');
  await expect(page.getByText('CSD-PRJ-0002')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/(login|session)/);
});

test('UAT 7: Project Manager has no Approvals, Banking, Payroll or Users & security', async ({
  page,
}) => {
  await signIn(page, 'manager');
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const hidden of ['Approvals', 'Cash, bank & UPI', 'Payroll', 'Users & security']) {
    await expect(nav).not.toContainText(hidden);
  }
  await expect(nav).toContainText('Tax invoices');
  const users = await page.request.get('/api/v1/users');
  expect(users.status()).toBe(403);
});

test('UAT 8: a scoped Site Engineer only reaches their own project, in the UI and the API', async ({
  page,
}) => {
  await signIn(page, 'site');
  const list = await page.request.get('/api/v1/projects');
  expect(list.status()).toBe(200);
  const projects = (await list.json()) as { id: string; code: string }[];
  expect(projects.map((p) => p.code)).toEqual(['CSD-PRJ-0001']);
  const other = await page.request.get('/api/v1/projects/00000000-0000-4000-8000-000000000000');
  expect(other.status()).toBe(404);
  // README §17: Site Engineers land on the mobile home, which lists only their own site.
  await expect(page).toHaveURL(/\/site$/);
  await expect(page.getByText('CSD-PRJ-0001')).toBeVisible();
  await expect(page.getByText('CSD-PRJ-0002')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '+ Add site expense' })).toBeVisible();
});

test('after sign-in, a crafted next= cannot send the user to another site', async ({ page }) => {
  await page.goto('/login?next=%2F%09%2Fevil.example%2Flogin');
  await page.getByLabel('Work email').fill(email('admin'));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good');
  expect(new URL(page.url()).host).toBe('localhost:3100');
});

test('the sign-in form posts, never GETs, even before scripts run', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('form')).toHaveAttribute('method', 'post');
});

test('API: unauthenticated calls get 401 and cross-site writes are refused', async ({
  request,
}) => {
  expect((await request.get('/api/v1/projects')).status()).toBe(401);
  const login = await request.post('/api/v1/auth/login', {
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    data: { email: email('owner'), password: PASSWORD },
  });
  expect(login.status()).toBe(403);
});
