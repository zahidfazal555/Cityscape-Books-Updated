import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** The owner approves a discount entered by a non-approver. */
export const POST = api<{ id: string }>(async ({ actor, params }) => {
  await services().quotations.approveDiscount(actor, params.id);
});
