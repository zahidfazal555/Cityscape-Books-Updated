import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Withdraws a pending payment, or (Owner only) reverses an approved one. */
export const DELETE = api<{ id: string }>(async ({ actor, params }) => {
  await services().labour.removePayment(actor, 'contract', params.id);
});
