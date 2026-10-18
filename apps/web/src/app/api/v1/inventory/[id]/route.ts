import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const DELETE = api<{ id: string }>(async ({ actor, params }) => {
  await services().inventory.remove(actor, params.id);
});
