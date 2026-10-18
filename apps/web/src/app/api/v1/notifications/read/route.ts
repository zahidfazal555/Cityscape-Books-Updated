import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Marks the given notifications (or all) read. */
export const POST = api(async ({ actor, body }) => {
  await services().notifications.markRead(actor, (body ?? {}) as { ids?: string[] });
});
