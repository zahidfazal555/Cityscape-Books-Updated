import type { ProformaUpdate } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api<{ id: string }>(async ({ actor, params }) =>
  services().proformas.get(actor, params.id),
);
/** Only while no advance has been received (FR-6.6). */
export const PATCH = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().proformas.update(actor, params.id, body as ProformaUpdate);
});
