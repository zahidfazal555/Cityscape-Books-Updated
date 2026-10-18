import type { CompleteInput } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** FR-23.5: before/after photos (uploaded first via /attachments), work done, optional cost. */
export const POST = api<{ id: string }>(async ({ actor, params, body }) =>
  services().visits.complete(actor, params.id, body as CompleteInput),
);
