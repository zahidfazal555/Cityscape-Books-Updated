import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Owner only: posts the expense on its date. */
export const POST = api<{ id: string }>(async ({ actor, params }) => {
  await services().expenses.approve(actor, params.id);
});
