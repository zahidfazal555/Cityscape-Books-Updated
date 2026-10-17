import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Owner only (H2): posts the rate change. */
export const POST = api<{ id: string }>(async ({ actor, params }) => {
  await services().payroll.approveRate(actor, params.id);
});
