import { z } from 'zod';
import { PO_STATUSES, type PoInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({
  projectId: z.string().uuid().optional(),
  status: z.enum(PO_STATUSES).optional(),
});

export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().purchaseOrders.list(actor, { projectId: q.projectId, status: q.status });
});
export const POST = api(async ({ actor, body }) =>
  services().purchaseOrders.create(actor, body as PoInput),
);
