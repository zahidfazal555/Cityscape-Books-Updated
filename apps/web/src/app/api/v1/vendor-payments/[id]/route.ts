import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Reverses an approved payment (`bills = full`) or withdraws a pending one. */
export const DELETE = api<{ id: string }>(async ({ actor, params }) => {
  await services().vendorPayments.remove(actor, params.id);
});
