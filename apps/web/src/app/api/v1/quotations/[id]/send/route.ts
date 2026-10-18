import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Draft → Sent (blocked while a discount waits for approval). */
export const POST = api<{ id: string }>(async ({ actor, params }) => {
  await services().quotations.send(actor, params.id);
});
