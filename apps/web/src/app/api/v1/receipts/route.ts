import { z } from 'zod';
import type { ReceiptInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ projectId: z.string().uuid().optional() });

export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().receipts.list(actor, { projectId: q.projectId });
});
export const POST = api(async ({ actor, body }) =>
  services().receipts.record(actor, body as ReceiptInput),
);
