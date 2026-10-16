import { z } from 'zod';
import type { PaymentInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({
  billId: z.string().uuid().optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().vendorPayments.list(actor, q);
});
/** Pending for non-approvers (H2); posted at once for the owner. */
export const POST = api(async ({ actor, body }) =>
  services().vendorPayments.record(actor, body as PaymentInput),
);
