import { expect, test } from '@playwright/test';
import { PASSWORD, email } from './fixtures';

test('a repeated POST with the same Idempotency-Key creates one invoice; a POST without a key is refused', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email('owner'));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good');

  const projects = (await (await page.request.get('/api/v1/projects')).json()) as {
    id: string;
    code: string;
  }[];
  const project = projects.find((p) => p.code === 'CSD-PRJ-0001')!;
  const origin = 'http://localhost:3100';
  const body = {
    projectId: project.id,
    invoiceDate: '2026-10-10',
    lines: [
      { description: 'Stage 1', qtyMilli: 1000, unit: 'lot', rate: 1_00_000_00, gstRate: 18 },
    ],
  };
  const post = (key?: string) =>
    page.request.post('/api/v1/invoices', {
      headers: {
        origin,
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      data: body,
    });

  const key = 'e2e-double-submit-0001';
  const [a, b] = [await post(key), await post(key)];
  expect(a.status()).toBe(200);
  expect(b.status()).toBe(200);
  expect(await b.json()).toEqual(await a.json());

  const all = (await (
    await page.request.get(`/api/v1/invoices?projectId=${project.id}`)
  ).json()) as unknown[];
  expect(all).toHaveLength(1);

  const missing = await post();
  expect(missing.status()).toBe(422);
  expect(((await missing.json()) as { error: { message: string } }).error.message).toContain(
    'Idempotency-Key',
  );
});
