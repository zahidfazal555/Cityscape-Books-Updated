import { z } from 'zod';
import type { ContractPayInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({
  jobId: z.string().uuid().optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().labour.payments(actor, 'contract', { targetId: q.jobId, status: q.status });
});
/** Pending for non-owners (H2). */
export const POST = api(async ({ actor, body }) =>
  services().labour.payContract(actor, body as ContractPayInput),
);
