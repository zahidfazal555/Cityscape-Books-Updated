import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Draft → Issued. */
export const POST = api<{ id: string }>(async ({ actor, params }) => {
  await services().purchaseOrders.issue(actor, params.id);
});
