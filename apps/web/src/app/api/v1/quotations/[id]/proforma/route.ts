import type { FromQuoteInput } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** A stage proforma for a share of an accepted quote (FR-5.6). */
export const POST = api<{ id: string }>(async ({ actor, params, body }) =>
  services().proformas.fromQuote(actor, params.id, body as FromQuoteInput),
);
