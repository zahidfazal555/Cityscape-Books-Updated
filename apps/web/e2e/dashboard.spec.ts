import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, email } from './fixtures';

async function signIn(page: Page, role: Parameters<typeof email>[0]) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email(role));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good');
}

test('dashboard (README §2): the Owner sees KPIs, projects with net value, spend and ageing; no CSP violations', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await signIn(page, 'owner');
  for (const kpi of [
    'Client receivables',
    'Vendor payables',
    'Cash & bank balance',
    'Waiting for your approval',
  ])
    await expect(page.getByText(kpi, { exact: true })).toBeVisible();
  const projects = page.getByRole('table', { name: 'Projects' });
  await expect(projects.getByRole('columnheader', { name: 'Net value' })).toBeVisible();
  await expect(projects.getByRole('row').nth(1)).toContainText('CSD-PRJ-');
  await expect(page.getByRole('heading', { name: 'Spend by category' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Spend by project' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Receivables by age' })).toBeVisible();
  // A project row opens the project.
  await projects.getByRole('row').nth(1).getByRole('link').click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  expect(violations).toEqual([]);
});

test('dashboard: the project manager has no cash figure, no net value and no approvals card', async ({
  page,
}) => {
  await signIn(page, 'manager');
  await expect(page.getByText('Client receivables', { exact: true })).toBeVisible();
  await expect(page.getByText('Collected this year', { exact: true })).toBeVisible();
  await expect(page.getByText('Cash & bank balance', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Waiting for your approval', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('table', { name: 'Projects' }).getByRole('columnheader', { name: 'Net value' }),
  ).toHaveCount(0);
});
