import { expect, test } from '@playwright/test';
import { withDb } from './db';
import { JPEG, PASSWORD, email } from './fixtures';

test('API: a manager uploads a bill photo and records an expense; it waits for the owner; the photo has no GPS', async ({
  page,
  baseURL,
}) => {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email('manager'));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good');
  const origin = { origin: baseURL ?? '' };

  const svg = await page.request.post('/api/v1/attachments', {
    headers: { ...origin, 'content-type': 'image/svg+xml' },
    data: Buffer.from('<svg onload="alert(1)"/>'),
  });
  expect(svg.status()).toBe(422);

  const up = await page.request.post('/api/v1/attachments', {
    headers: { ...origin, 'content-type': 'image/jpeg' },
    data: JPEG,
  });
  expect(up.status()).toBe(200);
  const { id: attachmentId } = (await up.json()) as { id: string };

  const projectId = await withDb(
    async (c) => (await c.query<{ id: string }>('SELECT id FROM project LIMIT 1')).rows[0]!.id,
  );
  const res = await page.request.post('/api/v1/expenses', {
    headers: { ...origin, 'idempotency-key': crypto.randomUUID() },
    data: {
      projectId,
      txnDate: new Date().toISOString().slice(0, 10),
      amount: 1_250_00,
      particulars: 'Tile adhesive',
      category: 'material',
      paidBy: 'Shiva',
      mode: 'cash',
      attachmentId,
    },
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'pending' });

  const photo = await page.request.get(`/api/v1/attachments/${attachmentId}`);
  expect(photo.headers()['content-type']).toBe('image/jpeg');
  expect(photo.headers()['x-content-type-options']).toBe('nosniff');
  expect((await photo.body()).toString('latin1')).not.toContain('GPS');
  // Not the owner: no approval queue.
  expect((await page.request.get('/api/v1/approvals')).status()).toBe(403);
});
