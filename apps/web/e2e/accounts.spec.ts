import { expect, test, type Page } from '@playwright/test';
import { todayIn } from '@csd/core';
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
  // The business day in India, as the app sees it (not the UTC date).
  const today = todayIn();
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
  // The e2e company has no GSTIN: no download link, a hint instead, and the API refuses.
  await expect(page.getByRole('link', { name: 'GSTR-1 JSON' })).toHaveCount(0);
  await expect(page.getByText('GSTR-1 JSON needs the company GSTIN')).toBeVisible();
  const json = await page.request.get(`/api/v1/gst/${today.slice(0, 7)}/gstr1`);
  expect(json.status()).toBe(422);
  // A month outside the recent chips still loads with its own chip (BUG-139).
  await page.goto('/gst?period=2025-01');
  await expect(page.getByRole('link', { name: 'Jan 2025' })).toBeVisible();
  await page.goto('/gst?period=2025-13');
  await expect(page.getByRole('heading', { name: 'GST returns' })).toBeVisible();

  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'CSD-PRJ-0002' })).toBeVisible();
  await page.getByRole('link', { name: 'Trial balance' }).click();
  await expect(page.getByRole('status')).toContainText('Debits equal credits');
  await page.getByLabel('As at').fill('2000-01-01');
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(page.getByText('Balances as at 01 Jan 2000')).toBeVisible();

  await page.getByRole('link', { name: 'Cash, bank & UPI' }).click();
  const before = Number((await page.getByTestId('unmatched').innerText()).split(' ')[0]);
  const line = page
    .getByRole('row')
    .filter({ hasText: 'UTR-ACC-E2E' })
    .or(page.getByRole('row').filter({ hasText: `for ${number}` }));
  await line.first().getByRole('checkbox', { name: 'Matched with statement' }).check();
  await page.reload();
  await expect(page.getByTestId('unmatched')).toContainText(String(before - 1));

  // A blank opening balance is refused, not saved as zero (BUG-132).
  await page.getByRole('button', { name: 'Opening balance' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Enter the opening balance (0 removes it).')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

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

test('BUG-134: a manager limited to some projects does not see GST returns or banking', async ({
  browser,
}) => {
  const restore = await withDb(async (c) => {
    const u = (
      await c.query<{ id: string; company_id: string }>(
        `SELECT id, company_id FROM app_user WHERE email = $1`,
        [email('manager')],
      )
    ).rows[0]!;
    const p = (await c.query<{ id: string }>(`SELECT id FROM project ORDER BY code LIMIT 1`))
      .rows[0]!;
    await c.query(`UPDATE app_user SET projects_all = false WHERE id = $1`, [u.id]);
    await c.query(
      `INSERT INTO user_project (company_id, user_id, project_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [u.company_id, u.id, p.id],
    );
    return u.id;
  });
  try {
    const pm = await (await browser.newContext()).newPage();
    await signIn(pm, 'manager');
    await expect(pm.getByRole('link', { name: 'Reports' })).toBeVisible();
    await expect(pm.getByRole('link', { name: 'GST returns' })).toHaveCount(0);
    await expect(pm.getByRole('link', { name: 'Cash, bank & UPI' })).toHaveCount(0);
  } finally {
    await withDb(async (c) => {
      await c.query(`DELETE FROM user_project WHERE user_id = $1`, [restore]);
      await c.query(`UPDATE app_user SET projects_all = true WHERE id = $1`, [restore]);
    });
  }
});
