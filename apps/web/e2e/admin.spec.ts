import { expect, test, type Page } from '@playwright/test';
import { acceptInvite, withDb } from './db';
import { PASSWORD, email } from './fixtures';

async function signIn(
  page: Page,
  who: string,
  password = PASSWORD,
  { expectFailure = false } = {},
) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(who);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (!expectFailure) await expect(page.getByRole('heading', { level: 1 })).toContainText('Good');
}

test('UAT 12: owner creates a user with custom rights, deactivates them; they cannot sign in; it is all audited', async ({
  page,
  browser,
}) => {
  await signIn(page, email('owner'));
  await page.getByRole('link', { name: 'Users & security' }).click();
  await page.getByRole('button', { name: '+ Add user' }).click();
  const drawer = page.getByRole('dialog', { name: 'Add user' });
  await drawer.getByLabel('Name or role title').fill('Asst. Manager Priya');
  await drawer.getByLabel('Work email').fill('priya@e2e.test');
  await drawer.getByRole('radio', { name: 'Asst. Manager · Project Management' }).click();
  await drawer
    .getByRole('radiogroup', { name: 'Cash, bank & UPI' })
    .getByRole('radio', { name: 'View' })
    .click();
  await expect(drawer.getByText('Custom', { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Add user & send invite' }).click();
  const row = page.getByRole('row').filter({ hasText: 'priya@e2e.test' });
  await expect(row).toContainText('Custom rights');
  await expect(row).toContainText('Invite pending');

  await acceptInvite('priya@e2e.test', 'Priya-site-visit-2026');
  const other = await browser.newContext();
  const priya = await other.newPage();
  await signIn(priya, 'priya@e2e.test', 'Priya-site-visit-2026');
  await expect(priya.getByRole('navigation', { name: 'Main' })).toContainText('Cash, bank & UPI');

  await row.getByRole('button', { name: 'Deactivate' }).click();
  await expect(row).toContainText('Inactive');
  // Signed out at once: her next request is refused, and she cannot sign in again.
  expect((await priya.request.get('/api/v1/me')).status()).toBe(401);
  await signIn(priya, 'priya@e2e.test', 'Priya-site-visit-2026', { expectFailure: true });
  await expect(priya.getByRole('alert').filter({ hasText: 'Email or password' })).toBeVisible();
  await other.close();

  await page.getByRole('link', { name: 'Audit trail' }).click();
  for (const action of ['deactivate', 'create']) {
    await expect(page.getByRole('row').filter({ hasText: action }).first()).toBeVisible();
  }
  const actions = await withDb(async (c) =>
    (
      await c.query<{ action: string }>(
        `SELECT action FROM audit_log a JOIN app_user u ON u.id::text = a.entity_id WHERE u.email = 'priya@e2e.test' ORDER BY a.id`,
      )
    ).rows.map((r) => r.action),
  );
  expect(actions).toEqual(expect.arrayContaining(['create', 'login', 'deactivate']));
});

test('owner sets the books lock date from Security', async ({ page }) => {
  await signIn(page, email('owner'));
  await page.goto('/settings/security');
  await page.getByLabel('Lock date').fill('2026-10-15');
  await page.getByRole('button', { name: 'Update lock' }).click();
  await expect(page.getByText('Lock date updated.')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toContainText(
    'Books locked till 15 Oct 2026',
  );
  await page.getByLabel('Lock date').fill('2026-09-30');
  await page.getByRole('button', { name: 'Update lock' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toContainText(
    'Books locked till 30 Sep 2026',
  );
});

test('PM adds a client (GSTIN checked against the state) and creates a project for it', async ({
  page,
}) => {
  await signIn(page, email('manager'));
  await page.getByRole('link', { name: 'Clients & vendors' }).click();
  await page.getByRole('button', { name: '+ Add client' }).click();
  const drawer = page.getByRole('dialog', { name: 'Add client' });
  await drawer.getByLabel('Name', { exact: true }).fill('Vertex Labs LLP');
  await drawer.getByLabel('GSTIN (leave blank if unregistered)').fill('29AAKFV7731M1Z0');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect(drawer.getByRole('alert')).toContainText('GSTIN');
  await drawer.getByLabel('GSTIN (leave blank if unregistered)').fill('');
  await drawer.getByLabel('State').selectOption('29');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Vertex Labs LLP' })).toContainText(
    'Karnataka',
  );

  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('button', { name: '+ New project' }).click();
  const p = page.getByRole('dialog', { name: 'New project' });
  await p.getByLabel('Project name').fill('Vertex Labs Office Fit-out');
  await p.getByLabel('Client').selectOption({ label: 'Vertex Labs LLP' });
  await p.getByLabel('Contract value (₹, excl. GST)').fill('18,50,000');
  await p.getByLabel('Cost budget (₹)').fill('13,00,000');
  await expect(p.getByText('29.7% planned margin')).toBeVisible();
  await p.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Vertex Labs Office Fit-out');
  await expect(page.getByText('CSD-PRJ-0003')).toBeVisible();
  await expect(page.getByText('₹18,50,000')).toBeVisible();
  await page.getByRole('button', { name: 'Mark completed' }).click();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  // A PM cannot reopen a completed project.
  await expect(page.getByRole('button', { name: 'Reopen' })).toHaveCount(0);
});

test('Project Manager cannot open Users & security, even by URL', async ({ page }) => {
  await signIn(page, email('manager'));
  await page.goto('/settings/users');
  await expect(page.getByText('Users & security is available to the owner only.')).toBeVisible();
});
