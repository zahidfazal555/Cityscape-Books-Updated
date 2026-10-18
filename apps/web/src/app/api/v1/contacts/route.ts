import { z } from 'zod';
import type { ContactInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ type: z.enum(['client', 'vendor']), q: z.string().max(100).default('') });

export const GET = api(async ({ actor, req }) => {
  const { type, q } = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().contacts.list(actor, type, q);
});
export const POST = api(async ({ actor, body }) => ({
  id: await services().contacts.create(actor, body as ContactInput),
}));
