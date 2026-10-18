import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const POST = api<{ id: string }>(async ({ actor, params }) => {
  await services().users.resendInvite(actor, params.id);
});
