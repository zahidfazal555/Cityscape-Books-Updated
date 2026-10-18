import { expect, test, type Page } from '@playwright/test';
import { JPEG, PASSWORD, email } from './fixtures';

async function signIn(page: Page, role: 'owner' | 'site' | 'manager') {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email(role));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good');
}

const file = (name: string) => ({ name, mimeType: 'image/jpeg', buffer: JPEG });

test('support: handover, a warranty ticket with a template reply, a site visit completed on the phone, its cost approved', async ({
  page,
  browser,
}) => {
  await signIn(page, 'owner');

  // Warranty register: hand over CSD-PRJ-0002, so a warranty claim on it is free.
  await page.getByRole('link', { name: 'Warranty register' }).click();
  await page.getByRole('button', { name: 'Record handover for CSD-PRJ-0002' }).click();
  await page.getByLabel('Handover date').fill('2026-10-01');
  await page.getByRole('dialog').getByText('1 year', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'CSD-PRJ-0002' })).toContainText(
    'In warranty',
  );

  // Knowledge base: a reply template with placeholders.
  await page.goto('/kb?tab=templates');
  await page.getByRole('button', { name: '+ New template' }).click();
  await page.getByLabel('Name').fill('E2E visit confirmation');
  await page.getByLabel('Message').fill('Dear {client}, ticket {ticket} is booked.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'E2E visit confirmation' })).toBeVisible();

  // Log a High warranty claim; the drawer shows coverage live.
  await page.getByRole('link', { name: 'Tickets' }).click();
  await page.getByRole('button', { name: '+ Log ticket' }).click();
  const project = page.getByRole('dialog').getByLabel('Project');
  const value = await project.locator('option', { hasText: 'CSD-PRJ-0002' }).getAttribute('value');
  await project.selectOption(value ?? '');
  await page.getByLabel('Type').selectOption('warranty');
  await expect(page.getByRole('status')).toContainText('In warranty · free');
  await page.getByLabel('Subject').fill('E2E laminate peeling');
  await page.getByRole('dialog').getByText('High', { exact: true }).click();
  await page.getByLabel('Caller phone').fill('9840012345');
  await page.getByRole('button', { name: 'Log ticket', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'E2E laminate peeling' })).toBeVisible();

  // Reply with the template: the first response is stamped.
  await page.getByLabel('Insert template').selectOption({ label: 'E2E visit confirmation' });
  await expect(page.getByLabel('Message')).toHaveValue(/ticket TKT-\d{4} is booked/);
  await page.getByRole('button', { name: 'Post reply to client' }).click();
  await expect(page.getByRole('list', { name: 'Activity' })).toContainText('is booked');
  await expect(page.getByText(/^Responded in/)).toBeVisible();

  // Schedule a visit for the site engineer.
  await page.getByRole('button', { name: 'Schedule visit' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Schedule' }).click();
  await expect(page.getByLabel('Status')).toHaveValue('visit_scheduled');
  const ticketUrl = page.url();

  // The site engineer completes it on the phone with photos and a ₹1,200 cost.
  const phone = await (
    await browser.newContext({ viewport: { width: 390, height: 844 } })
  ).newPage();
  await signIn(phone, 'site');
  await phone.getByRole('link', { name: /E2E laminate peeling/ }).click();
  await expect(phone.getByRole('link', { name: /Call/ })).toHaveAttribute('href', 'tel:9840012345');
  await phone.locator('#ph-before').setInputFiles(file('before.jpg'));
  await expect(phone.getByText('Before photos (required): 1 added')).toBeVisible();
  await phone.locator('#ph-after').setInputFiles(file('after.jpg'));
  await expect(phone.getByText('After photos (required): 1 added')).toBeVisible();
  await phone.getByLabel('What was done (required)').fill('Re-pressed the laminate edge');
  await phone.getByLabel('Cost (₹, optional)').fill('1200');
  await phone.locator('#ph-bill').setInputFiles(file('bill.jpg'));
  await expect(phone.getByText(/Photo of the bill.*1 added/)).toBeVisible();
  await phone.getByRole('button', { name: 'Complete visit' }).click();
  await expect(phone.getByRole('heading', { level: 1 })).toContainText('Good');

  // The cost waits for the owner; the ticket is back In progress.
  await page.goto('/approvals');
  const card = page.getByRole('article').filter({ hasText: 'Service visit TKT-' });
  await expect(card).toContainText('₹1,200');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);
  await page.goto(ticketUrl);
  await expect(page.getByLabel('Status')).toHaveValue('in_progress');
  await expect(page.getByRole('list', { name: 'Activity' })).toContainText(
    'Work done: Re-pressed the laminate edge',
  );

  // Resolve and record the customer's rating.
  await page.getByLabel('Status').selectOption('resolved');
  await page.getByRole('radio', { name: '5 stars' }).click();
  await page.getByRole('button', { name: 'Save rating' }).click();
  await expect(page.getByRole('list', { name: 'Activity' })).toContainText('Customer rating 5/5');

  // A manager can view tickets but not log them.
  const pm = await (await browser.newContext()).newPage();
  await signIn(pm, 'manager');
  await pm.goto('/tickets');
  await expect(pm.getByRole('button', { name: '+ Log ticket' })).toHaveCount(0);
});
