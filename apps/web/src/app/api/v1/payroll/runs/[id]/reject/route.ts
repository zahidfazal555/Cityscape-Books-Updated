import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Owner only (H2), with a reason. Nothing posts. */
export const POST = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().payroll.rejectRun(actor, params.id, body as { reason: string });
});
