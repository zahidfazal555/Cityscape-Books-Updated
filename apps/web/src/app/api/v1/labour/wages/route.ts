import { z } from 'zod';
import type { WageInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({
  workerId: z.string().uuid().optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().labour.payments(actor, 'wage', { targetId: q.workerId, status: q.status });
});
/** Pending for non-owners (H2). */
export const POST = api(async ({ actor, body }) =>
  services().labour.payWages(actor, body as WageInput),
);
