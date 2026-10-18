import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** The owner approves a discount entered by a non-approver, at the version they saw. */
export const POST = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().quotations.approveDiscount(actor, params.id, body as { version: number });
});
