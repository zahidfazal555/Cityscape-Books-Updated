import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Owner only (H2): posts the payment. */
export const POST = api<{ id: string }>(async ({ actor, params }) => {
  await services().labour.approvePayment(actor, 'wage', params.id);
});
