import type { JobUpdate } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Work, progress, TDS rate or closing; the value goes through /value (H2). */
export const PATCH = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().labour.updateJob(actor, params.id, body as JobUpdate);
});
