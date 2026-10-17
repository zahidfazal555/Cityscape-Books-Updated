import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, email } from './fixtures';

async function signIn(page: Page, role: 'owner' | 'admin' | 'manager') {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email(role));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good');
}

test('payroll: a worker’s +1 and wages, an admin’s payment approved by the owner, and a payroll run', async ({
  page,
  browser,
}) => {
  await signIn(page, 'owner');
  await page.getByRole('link', { name: 'Payroll' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Payroll');

  // Monthly staff: the owner's salary applies at once; processing makes a payslip per person.
  await page.getByRole('button', { name: '+ Add employee' }).click();
  await page.getByLabel('Name').fill('E2E Designer');
  await page.getByLabel('Designation').fill('Design');
  await page.getByLabel('Monthly gross (₹)').fill('42000');
  await page.getByRole('dialog').getByRole('button', { name: 'Add' }).click();
  const staffRow = page.getByRole('row').filter({ hasText: 'E2E Designer' });
  await expect(staffRow).toContainText('₹42,000');

  // Daily-wage labour: add a worker, mark today, pay part of the balance.
  await page.getByRole('link', { name: 'Daily-wage labour' }).click();
  await page.getByRole('button', { name: '+ Add worker' }).click();
  await page.getByLabel('Name').fill('E2E Mason');
  await page.getByLabel('Trade').fill('Mason');
  await page.getByLabel('Project').selectOption({ index: 1 });
  await page.getByLabel('Daily rate (₹)').fill('1000');
  await page.getByRole('dialog').getByRole('button', { name: 'Add' }).click();
  const worker = page.getByRole('row').filter({ hasText: 'E2E Mason' });
  await worker.getByRole('button', { name: 'Mark E2E Mason present today' }).click();
  await expect(worker).toContainText('₹1,000');
  await expect(worker.getByRole('button', { name: 'Mark E2E Mason present today' })).toBeDisabled();

  // The admin pays ₹600: it waits for the owner and the balance holds it.
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, 'admin');
  await admin.goto('/payroll?tab=labour');
  const aRow = admin.getByRole('row').filter({ hasText: 'E2E Mason' });
  await aRow.getByRole('button', { name: 'Pay wages' }).click();
  await admin.getByLabel('Amount (₹)').fill('600');
  await admin.getByRole('dialog').getByText('Cash', { exact: true }).click();
  await admin.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(aRow).toContainText('₹600 waiting');

  await page.goto('/approvals');
  await page.getByRole('radio', { name: /Payroll · / }).click();
  const card = page.getByRole('article').filter({ hasText: 'Wages to E2E Mason' });
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);
  await page.goto('/payroll?tab=labour');
  await expect(page.getByRole('row').filter({ hasText: 'E2E Mason' })).toContainText('₹400');

  // Process this month's payroll as the owner; the payslips page lists the new employee.
  await page.goto('/payroll');
  await page.getByRole('button', { name: /^Process .* payroll$/ }).click();
  await page.getByRole('dialog').getByText('Cash', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: /payroll processed$/ })).toBeDisabled();
  await page.getByRole('link', { name: 'Payslips' }).first().click();
  await expect(page.getByRole('article').filter({ hasText: 'E2E Designer' })).toContainText(
    '₹42,000',
  );

  // A manager has no payroll right: no nav entry.
  const pm = await (await browser.newContext()).newPage();
  await signIn(pm, 'manager');
  await expect(pm.getByRole('link', { name: 'Payroll' })).toHaveCount(0);
});

test('inventory: a manager records a material purchase; the average rate and category card show', async ({
  page,
}) => {
  await signIn(page, 'manager');
  await page.getByRole('link', { name: 'Inventory' }).click();
  await page.getByRole('button', { name: '+ Record purchase' }).click();
  await page.getByLabel('Project').selectOption({ index: 1 });
  await page.getByLabel('Item').fill('E2E teak beading');
  await page.getByLabel('Category').selectOption('Wood');
  await page.getByLabel('Quantity').fill('140');
  await page.getByLabel('Unit').fill('Rft');
  await page.getByLabel('Amount (₹)').fill('7337');
  await page.getByLabel('Vendor').fill('Cochin Timber');
  await page.getByRole('button', { name: 'Record' }).click();
  const row = page.getByRole('row').filter({ hasText: 'E2E teak beading' });
  await expect(row).toContainText('₹52.41');
  await expect(page.getByText(/^Wood · \d+$/)).toBeVisible();
  const csv = await page.request.get('/api/v1/inventory/export');
  expect(await csv.text()).toContain('E2E teak beading');
});
