import { z } from 'zod';
import { QUOTE_STATUSES, type QuoteInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ status: z.enum(QUOTE_STATUSES).optional() });

export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().quotations.list(actor, { status: q.status });
});
export const POST = api(async ({ actor, body }) =>
  services().quotations.create(actor, body as QuoteInput),
);
