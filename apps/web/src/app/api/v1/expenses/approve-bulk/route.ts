import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** "Approve all": each entry in its own transaction, at the version shown; returns which succeeded. */
export const POST = api(async ({ actor, body }) =>
  services().expenses.approveMany(actor, body as { items: { id: string; version: number }[] }),
);
