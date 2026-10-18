import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** H2: applied at once for the Owner, pending for anyone else. */
export const POST = api<{ id: string }>(async ({ actor, params, body }) =>
  services().labour.requestJobValue(actor, params.id, body as { value: number }),
);
