import { z } from 'zod';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  entity: z.string().max(40).optional(),
});

export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().audit.list(actor, { beforeId: q.before, limit: q.limit, entity: q.entity });
});
