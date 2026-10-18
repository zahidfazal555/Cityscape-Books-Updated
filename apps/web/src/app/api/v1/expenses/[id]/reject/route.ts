import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Owner only, with a reason. Nothing posts. */
export const POST = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().expenses.reject(actor, params.id, body as { reason: string });
});
