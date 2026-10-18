import type { CreateUserInput } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api(async ({ actor }) => services().users.list(actor));
export const POST = api(async ({ actor, body }) => ({
  id: await services().users.create(actor, body as CreateUserInput),
}));
