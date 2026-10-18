import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Owner only: posts the expense on its date, at the version the Owner saw. */
export const POST = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().expenses.approve(actor, params.id, body as { version: number });
});
