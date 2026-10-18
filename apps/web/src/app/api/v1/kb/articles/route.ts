import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api(async ({ actor }) => services().kb.articles(actor));
/** `kb ≥ edit`. */
export const POST = api(async ({ actor, body }) =>
  services().kb.saveArticle(
    actor,
    null,
    body as Parameters<ReturnType<typeof services>['kb']['saveArticle']>[2],
  ),
);
