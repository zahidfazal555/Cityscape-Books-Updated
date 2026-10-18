import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const PATCH = api<{ id: string }>(async ({ actor, params, body }) =>
  services().kb.saveArticle(
    actor,
    params.id,
    body as Parameters<ReturnType<typeof services>['kb']['saveArticle']>[2],
  ),
);
/** `kb = full` (soft delete). */
export const DELETE = api<{ id: string }>(async ({ actor, params }) => {
  await services().kb.remove(actor, 'article', params.id);
});
