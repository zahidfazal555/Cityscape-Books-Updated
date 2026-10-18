import { z } from 'zod';
import { TICKET_VIEWS, type TicketInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ view: z.enum(TICKET_VIEWS).default('open') });

/** The queue (FR-19.6): breached first, then priority, then oldest. */
export const GET = api(async ({ actor, req }) => {
  const { view } = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().tickets.list(actor, view);
});
/** "Log ticket" (FR-19.2); coverage is decided now. */
export const POST = api(async ({ actor, body }) =>
  services().tickets.create(actor, body as TicketInput),
);
