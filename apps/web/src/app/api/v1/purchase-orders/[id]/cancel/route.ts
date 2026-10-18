import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Cancel only when no bill is linked (FR-9.3). */
export const POST = api<{ id: string }>(async ({ actor, params }) => {
  await services().purchaseOrders.cancel(actor, params.id);
});
