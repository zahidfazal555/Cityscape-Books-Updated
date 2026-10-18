import type { InvoiceUpdate } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api<{ id: string }>(async ({ actor, params }) =>
  services().invoices.get(actor, params.id),
);
export const PATCH = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().invoices.update(actor, params.id, body as InvoiceUpdate);
});
