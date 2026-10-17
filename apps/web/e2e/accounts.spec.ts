import { expect, test, type Page } from '@playwright/test';
import { withDb } from './db';
import { PASSWORD, email } from './fixtures';

async function signIn(page: Page, role: 'owner' | 'manager') {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email(role));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good');
}

test('accounts: outstanding, GST, reports and the bank register for an invoice and its receipt', async ({
  page,
  baseURL,
  browser,
}) => {
  await signIn(page, 'owner');
  const origin = { origin: baseURL ?? '' };
  const today = new Date().toISOString().slice(0, 10);
  const projectId = await withDb(
    async (c) =>
      (await c.query<{ id: string }>(`SELECT id FROM project WHERE code = 'CSD-PRJ-0002'`)).rows[0]!
        .id,
  );
  const inv = await page.request.post('/api/v1/invoices', {
    headers: { ...origin, 'idempotency-key': crypto.randomUUID() },
    data: {
      projectId,
      invoiceDate: today,
      dueDate: today,
      lines: [
        { description: 'Accounts e2e works', qtyMilli: 1000, rate: 2_00_000_00, gstRate: 18 },
      ],
    },
  });
  expect(inv.status()).toBe(200);
  const { id: invoiceId, number } = (await inv.json()) as { id: string; number: string };
  const rec = await page.request.post('/api/v1/receipts', {
    headers: { ...origin, 'idempotency-key': crypto.randomUUID() },
    data: {
      invoiceId,
      receiptDate: today,
      amount: 36_000_00,
      mode: 'bank',
      reference: 'UTR-ACC-E2E',
    },
  });
  expect(rec.status()).toBe(200);

  await page.getByRole('link', { name: 'Outstanding' }).click();
  const row = page.getByRole('row').filter({ hasText: number });
  await expect(row).toContainText('₹2,00,000');
  const csv = await page.request.get('/api/v1/outstanding/receivables/export');
  expect(await csv.text()).toContain(number);

  await page.getByRole('link', { name: 'GST returns' }).click();
  await expect(page.getByRole('row').filter({ hasText: number })).toContainText('B2C');
  const json = await page.request.get(`/api/v1/gst/${today.slice(0, 7)}/gstr1`);
  // The e2e company has no GSTIN: the download asks for it instead of producing a bad file.
  expect([200, 422]).toContain(json.status());

  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'CSD-PRJ-0002' })).toBeVisible();
  await page.getByRole('link', { name: 'Trial balance' }).click();
  await expect(page.getByRole('status')).toContainText('Debits equal credits');

  await page.getByRole('link', { name: 'Cash, bank & UPI' }).click();
  const before = Number((await page.getByTestId('unmatched').innerText()).split(' ')[0]);
  const line = page
    .getByRole('row')
    .filter({ hasText: 'UTR-ACC-E2E' })
    .or(page.getByRole('row').filter({ hasText: `for ${number}` }));
  await line.first().getByRole('checkbox', { name: 'Matched with statement' }).check();
  await page.reload();
  await expect(page.getByTestId('unmatched')).toContainText(String(before - 1));

  // A manager has reports but neither P&L nor the trial balance.
  const pm = await (await browser.newContext()).newPage();
  await signIn(pm, 'manager');
  await pm.goto('/reports');
  await expect(pm.getByRole('link', { name: 'Project profit & loss' })).toHaveCount(0);
  await expect(pm.getByRole('link', { name: 'Trial balance' })).toHaveCount(0);
  const header = pm.getByRole('row').first();
  await expect(header).toContainText('Revenue');
  await expect(header).not.toContainText('Profit');
});
