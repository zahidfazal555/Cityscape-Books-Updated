import { z } from 'zod';
import type { InvoiceInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({
  projectId: z.string().uuid().optional(),
  status: z.enum(['unpaid', 'partially_paid', 'paid', 'overdue', 'cancelled']).optional(),
});

export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().invoices.list(actor, { projectId: q.projectId, status: q.status });
});
export const POST = api(async ({ actor, body }) =>
  services().invoices.create(actor, body as InvoiceInput),
);
