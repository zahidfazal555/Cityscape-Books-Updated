import type { HandoverInput } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Record handover / edit warranty (FR-20.2); marks the project Completed. */
export const PATCH = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().warranty.recordHandover(actor, params.id, body as HandoverInput);
});
