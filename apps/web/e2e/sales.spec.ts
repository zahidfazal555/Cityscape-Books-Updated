import { expect, test, type Page } from '@playwright/test';
import { withDb } from './db';
import { PASSWORD, email } from './fixtures';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email('owner'));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good');
}

test('UAT 1: quote → revise → accept → 30% proforma → advance → tax invoice → paid, all on screen', async ({
  page,
}) => {
  await withDb((c) =>
    c.query(
      `INSERT INTO contact (company_id, type, name, state_code, address)
       SELECT id, 'client', 'Anand Textiles', '33', 'Anna Salai, Chennai' FROM company`,
    ),
  );
  await signIn(page);

  await page.getByRole('link', { name: 'Quotations' }).click();
  await page.getByRole('button', { name: '+ New quotation' }).click();
  const qd = page.getByRole('dialog', { name: 'New quotation' });
  await qd.getByLabel('Client').selectOption({ label: 'Anand Textiles' });
  await qd.getByLabel('Proposal title').fill('Showroom interiors');
  await qd.getByLabel('Site', { exact: true }).fill('T. Nagar');
  await qd.getByLabel('Line 1 description').fill('Showroom fit-out');
  await qd.getByLabel('Line 1 quantity').fill('1');
  await qd.getByLabel('Line 1 rate').fill('500000');
  // ₹5,00,000 + 18% GST, split CGST+SGST for a Tamil Nadu client.
  await expect(qd.getByTestId('doc-total')).toHaveText('₹5,90,000');
  await qd.getByRole('button', { name: 'Save draft' }).click();

  await expect(page.getByRole('article')).toContainText('QUOTATION');
  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await page.getByRole('button', { name: 'Revise', exact: true }).click();
  await expect(page.getByText('Revision 1')).toBeVisible();
  await expect(page.getByRole('article')).toContainText('QUOTATION · R1');
  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await page.getByRole('button', { name: 'Mark accepted' }).click();
  const accept = page.getByRole('dialog');
  await expect(accept.getByLabel('Cost budget (₹)')).toHaveValue('375000');
  await accept.getByRole('button', { name: 'Accept & create project' }).click();
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create proforma' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create proforma' }).click();
  await expect(page.getByRole('article')).toContainText('PROFORMA INVOICE');
  // 30% of ₹5,00,000 = ₹1,50,000 + GST = ₹1,77,000.
  await expect(page.getByRole('article')).toContainText('₹1,77,000');

  await page.getByRole('button', { name: 'Record advance' }).click();
  const adv = page.getByRole('dialog', { name: 'Record advance' });
  await adv.getByLabel('Amount (₹)').fill('100000');
  await adv.getByLabel('UTR / transaction reference').fill('UTR-E2E-1');
  await adv.getByRole('button', { name: 'Save receipt' }).click();
  await expect(page.getByText('Partially paid')).toBeVisible();

  await page.getByRole('button', { name: 'Convert to tax invoice' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Issue tax invoice' }).click();
  await expect(page.getByRole('article')).toContainText('TAX INVOICE');
  await expect(page.getByText('Partially paid')).toBeVisible();
  await expect(page.getByText('Balance due')).toContainText('₹77,000');

  await page.getByRole('button', { name: 'Record receipt' }).click();
  const rc = page.getByRole('dialog', { name: 'Record receipt' });
  await rc.getByRole('button', { name: 'Full ₹77,000' }).click();
  await rc.getByRole('radio', { name: 'UPI' }).click();
  await rc.getByLabel('UPI reference').fill('UPI-E2E-2');
  await rc.getByRole('button', { name: 'Save receipt' }).click();
  await expect(page.getByText('Paid', { exact: true })).toBeVisible();

  // The receipts register shows the advance against the proforma and the final payment.
  await page.getByRole('link', { name: 'Client receipts' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'advance · PI/' })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: 'UPI-E2E-2' })).toHaveCount(1);
});
