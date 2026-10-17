import { expect, test, type Page } from '@playwright/test';
import { withDb } from './db';
import { JPEG, PASSWORD, email } from './fixtures';

async function signIn(page: Page, role: 'owner' | 'manager' | 'site') {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email(role));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good');
}

test('site engineer on a phone: adds an expense with a bill photo; it waits for the owner, who approves it', async ({
  browser,
}) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await phone.newPage();
  await signIn(page, 'site');
  await page.getByRole('link', { name: '+ Add site expense' }).click();
  await page.getByLabel('Site').selectOption({ index: 1 });
  await page.getByLabel('Amount (₹)').fill('1850');
  await page.getByLabel('What it was for').fill('Grout and spacers');
  await page.getByRole('radio', { name: 'Cash' }).click();
  await page.getByLabel('Paid to').fill('Local hardware');
  await page
    .locator('#e-photo')
    .setInputFiles({ name: 'bill.jpg', mimeType: 'image/jpeg', buffer: JPEG });
  await expect(page.getByText('Bill photo attached ✓')).toBeVisible();
  await expect(page.getByText('This goes to the owner for approval')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page).toHaveURL(/\/site$/);
  const entry = page.getByRole('listitem').filter({ hasText: 'Grout and spacers' });
  await expect(entry).toContainText('Pending');
  await phone.close();

  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await signIn(owner, 'owner');
  const views = () =>
    withDb(
      async (c) =>
        (await c.query(`SELECT 1 FROM audit_log WHERE entity = 'attachment' AND action = 'view'`))
          .rowCount,
    );
  const viewsBefore = await views();
  await owner.getByRole('link', { name: 'Approvals' }).click();
  const card = owner.getByRole('article').filter({ hasText: 'Grout and spacers' });
  await expect(card).toContainText('₹1,850');
  // BUG-110: the card shows a thumbnail; loading the queue is not a photo view.
  await expect(card.locator('img')).toBeVisible();
  expect(await views()).toBe(viewsBefore);
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);
  await owner.getByRole('link', { name: 'Expenses' }).click();
  const row = owner.getByRole('row').filter({ hasText: 'Grout and spacers' });
  await expect(row).toContainText('Approved');
  // BUG-111: the photo opens from the list even after the 15-minute access token is gone
  // (the viewer refreshes the session instead of claiming the bill is a PDF).
  await ownerCtx.clearCookies({ name: 'csd_at' });
  await row.getByRole('button', { name: 'View' }).click();
  await expect(owner.getByRole('img', { name: 'Bill photo' })).toBeVisible();
  expect(await views()).toBe((viewsBefore ?? 0) + 1);
  await ownerCtx.close();
});

test('owner: PO → issue → convert to bill (unregistered: no GST) → pay → Paid; a manager’s payment waits for approval', async ({
  page,
  browser,
}) => {
  // An unregistered vendor: no GST on its PO or bill (FR-9.2, FR-10.2).
  await withDb((c) =>
    c.query(
      `INSERT INTO contact (company_id, type, name, state_code)
       SELECT id, 'vendor', 'Sri Balaji Plywoods', '33' FROM company`,
    ),
  );
  await signIn(page, 'owner');
  await page.getByRole('link', { name: 'Purchase orders' }).click();
  await page.getByRole('button', { name: '+ New PO' }).click();
  const pd = page.getByRole('dialog', { name: 'New purchase order' });
  await pd.getByLabel('Vendor').selectOption({ label: 'Sri Balaji Plywoods' });
  await pd.getByLabel('Deliver to (project)').selectOption({ index: 1 });
  await pd.getByLabel('Line 1 description').fill('Plywood 18mm');
  await pd.getByLabel('Line 1 quantity').fill('10');
  await pd.getByLabel('Line 1 rate').fill('2000');
  // Unregistered vendor: no GST on the PO.
  await expect(pd.getByText('No GST (unregistered vendor).')).toBeVisible();
  await expect(pd.getByTestId('doc-total')).toHaveText('₹20,000');
  await pd.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('article')).toContainText('PURCHASE ORDER');
  await page.getByRole('button', { name: 'Issue PO' }).click();
  await page.getByRole('button', { name: 'Convert to bill' }).click();
  const bd = page.getByRole('dialog');
  await expect(bd.getByLabel('Taxable amount (₹)')).toHaveValue('20000');
  await bd.getByLabel('Vendor bill no').fill('SBP-1042');
  await expect(bd.getByTestId('bill-total')).toHaveText('₹20,000');
  await bd.getByRole('button', { name: 'Save bill' }).click();
  await expect(page).toHaveURL(/\/bills$/);
  const row = page.getByRole('row').filter({ hasText: 'SBP-1042' });
  await expect(row).toContainText('Unpaid');
  await row.getByRole('button', { name: 'Pay' }).click();
  const pay = page.getByRole('dialog');
  await pay.getByLabel('Amount (₹)').fill('5000');
  await pay.getByLabel('UTR / transaction reference').fill('UTR-PO-1');
  await pay.getByRole('button', { name: 'Record payment' }).click();
  await expect(row).toContainText('Partially paid');

  const other = await browser.newContext();
  const pm = await other.newPage();
  await signIn(pm, 'manager');
  await pm.goto('/bills');
  const pmRow = pm.getByRole('row').filter({ hasText: 'SBP-1042' });
  await pmRow.getByRole('button', { name: 'Pay' }).click();
  const pmPay = pm.getByRole('dialog');
  await expect(pmPay.getByText('This goes to the owner for approval')).toBeVisible();
  await pmPay.getByRole('radio', { name: 'Cash' }).click();
  await pmPay.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(pmRow).toContainText('pending');
  await other.close();

  await page.getByRole('link', { name: 'Approvals' }).click();
  await page.getByRole('radio', { name: /Payments/ }).click();
  const card = page.getByRole('article').filter({ hasText: 'SBP-1042' });
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);
  await page.goto('/bills');
  await expect(page.getByRole('row').filter({ hasText: 'SBP-1042' })).toContainText('Paid');
});

test('BUG-113: an entry dated in a locked period offers Reject only', async ({ page, baseURL }) => {
  await signIn(page, 'manager');
  const origin = { origin: baseURL ?? '' };
  const up = await page.request.post('/api/v1/attachments', {
    headers: { ...origin, 'content-type': 'image/jpeg' },
    data: JPEG,
  });
  const { id: attachmentId } = (await up.json()) as { id: string };
  const projectId = await withDb(
    async (c) =>
      (await c.query<{ id: string }>(`SELECT id FROM project WHERE code = 'CSD-PRJ-0002'`)).rows[0]!
        .id,
  );
  const res = await page.request.post('/api/v1/expenses', {
    headers: { ...origin, 'idempotency-key': crypto.randomUUID() },
    data: {
      projectId,
      txnDate: '2026-10-01',
      amount: 500_00,
      particulars: 'Locked-month tea and snacks',
      category: 'misc',
      paidBy: 'Shiva',
      mode: 'cash',
      attachmentId,
    },
  });
  expect(res.status()).toBe(200);
  await withDb((c) => c.query(`UPDATE company SET lock_date = '2026-10-02'`));
  try {
    const owner = await page.context().browser()!.newPage();
    await signIn(owner, 'owner');
    await owner.goto('/approvals');
    const card = owner.getByRole('article').filter({ hasText: 'Locked-month tea and snacks' });
    await expect(card).toContainText('Locked period');
    await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Reject' })).toBeVisible();
  } finally {
    await withDb((c) => c.query(`UPDATE company SET lock_date = NULL`));
  }
});
