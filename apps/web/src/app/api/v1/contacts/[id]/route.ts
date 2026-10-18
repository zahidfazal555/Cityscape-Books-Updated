import type { ContactUpdate } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api<{ id: string }>(async ({ actor, params }) =>
  services().contacts.get(actor, params.id),
);
export const PATCH = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().contacts.update(actor, params.id, body as ContactUpdate);
});
/** Archive (soft delete). */
export const DELETE = api<{ id: string }>(async ({ actor, params }) => {
  await services().contacts.archive(actor, params.id);
});
