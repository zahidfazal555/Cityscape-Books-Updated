import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** `approvals = full`: posts the payment. */
export const POST = api<{ id: string }>(async ({ actor, params }) => {
  await services().vendorPayments.approve(actor, params.id);
});
