import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const PATCH = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().users.update(actor, params.id, body as Record<string, unknown>);
});
