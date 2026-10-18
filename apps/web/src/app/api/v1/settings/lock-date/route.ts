import { api } from '@/lib/http';
import { input, lockDate } from '@/lib/schemas';
import { services } from '@/lib/server';

export const PUT = api(async ({ actor, body }) => {
  await services().settings.setLockDate(actor, input(lockDate, body).lockDate);
});
