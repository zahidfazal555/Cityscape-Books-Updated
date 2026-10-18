import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Deletes (reverses) a receipt: `receipts = full`, open period only. */
export const DELETE = api<{ id: string }>(async ({ actor, params }) => {
  await services().receipts.remove(actor, params.id);
});
