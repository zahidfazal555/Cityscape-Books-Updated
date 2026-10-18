import { z } from 'zod';
import type { AdvanceInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() });

export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().payroll.advances(actor, q);
});
/** Pending for non-owners (H2). */
export const POST = api(async ({ actor, body }) =>
  services().payroll.recordAdvance(actor, body as AdvanceInput),
);
