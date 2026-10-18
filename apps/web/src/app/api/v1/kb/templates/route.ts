import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api(async ({ actor }) => services().kb.templates(actor));
/** `kb ≥ edit`. */
export const POST = api(async ({ actor, body }) =>
  services().kb.saveTemplate(
    actor,
    null,
    body as Parameters<ReturnType<typeof services>['kb']['saveTemplate']>[2],
  ),
);
