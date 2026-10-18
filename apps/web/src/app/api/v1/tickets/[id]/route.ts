import type { TicketUpdate } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api<{ id: string }>(async ({ actor, params }) =>
  services().tickets.get(actor, params.id),
);
/** Status, priority, assignee and chargeable (FR-19.3, FR-19.10). */
export const PATCH = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().tickets.update(actor, params.id, body as TicketUpdate);
});
