import type { QuoteUpdate } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api<{ id: string }>(async ({ actor, params }) =>
  services().quotations.get(actor, params.id),
);
export const PATCH = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().quotations.update(actor, params.id, body as QuoteUpdate);
});
/** Only drafts, with `quotes = full` (FR-5.8). */
export const DELETE = api<{ id: string }>(async ({ actor, params }) => {
  await services().quotations.remove(actor, params.id);
});
