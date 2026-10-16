import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** "Approve all": each id in its own transaction; returns which succeeded. */
export const POST = api(async ({ actor, body }) =>
  services().expenses.approveMany(actor, body as { ids: string[] }),
);
