import { z } from 'zod';
import { BILL_STATUSES, type BillInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({
  projectId: z.string().uuid().optional(),
  vendorId: z.string().uuid().optional(),
  status: z.enum(BILL_STATUSES).optional(),
});

export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().bills.list(actor, q);
});
export const POST = api(async ({ actor, body }) =>
  services().bills.create(actor, body as BillInput),
);
