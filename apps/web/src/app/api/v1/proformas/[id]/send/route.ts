import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Draft → Sent. */
export const POST = api<{ id: string }>(async ({ actor, params }) => {
  await services().proformas.send(actor, params.id);
});
