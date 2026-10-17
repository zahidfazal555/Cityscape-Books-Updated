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

  const owner = await browser.newPage();
  await signIn(owner, 'owner');
  await owner.getByRole('link', { name: 'Approvals' }).click();
  const card = owner.getByRole('article').filter({ hasText: 'Grout and spacers' });
  await expect(card).toContainText('₹1,850');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);
  await owner.getByRole('link', { name: 'Expenses' }).click();
  const row = owner.getByRole('row').filter({ hasText: 'Grout and spacers' });
  await expect(row).toContainText('Approved');
  // The bill photo opens from the list.
  await row.getByRole('button', { name: 'View' }).click();
  await expect(owner.getByRole('img', { name: 'Bill photo' })).toBeVisible();
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
