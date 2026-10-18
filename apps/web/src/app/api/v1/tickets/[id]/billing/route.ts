import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api<{ id: string }>(async ({ actor, params }) =>
  services().ticketBilling.get(actor, params.id),
);
/** Links a quotation or tax invoice to the ticket (FR-19.10). */
export const POST = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().ticketBilling.link(
    actor,
    params.id,
    body as { kind: 'quotation' | 'invoice'; id: string },
  );
});
