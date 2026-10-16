import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** A tax invoice from an accepted quote, discount applied to the rates (FR-5.6). */
export const POST = api<{ id: string }>(async ({ actor, params, body }) =>
  services().quotations.toInvoice(actor, params.id, body as { invoiceDate: string }),
);
