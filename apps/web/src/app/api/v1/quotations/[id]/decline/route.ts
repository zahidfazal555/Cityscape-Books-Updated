import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Sent → Declined. */
export const POST = api<{ id: string }>(async ({ actor, params }) => {
  await services().quotations.decline(actor, params.id);
});
