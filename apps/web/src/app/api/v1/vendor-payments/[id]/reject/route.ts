import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** `approvals = full`, with a reason. Nothing posts. */
export const POST = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().vendorPayments.reject(actor, params.id, body as { reason: string });
});
