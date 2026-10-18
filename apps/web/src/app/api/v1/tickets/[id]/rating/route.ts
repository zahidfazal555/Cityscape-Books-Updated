import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** FR-19.11: 1–5 stars once Resolved or Closed. */
export const POST = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().tickets.rate(
    actor,
    params.id,
    body as { rating: number; comment?: string | null },
  );
});
