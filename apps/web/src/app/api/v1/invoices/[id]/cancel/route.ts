import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Cancels the invoice and issues its credit note (invoices are never deleted). */
export const POST = api<{ id: string }>(async ({ actor, params, body }) =>
  services().invoices.cancel(actor, params.id, body as { cnDate: string; reason: string }),
);
