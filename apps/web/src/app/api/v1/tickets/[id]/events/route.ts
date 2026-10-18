import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Reply to client, call log or internal note (FR-19.8). */
export const POST = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().tickets.addEvent(
    actor,
    params.id,
    body as { kind: 'reply' | 'call' | 'note'; body: string },
  );
});
