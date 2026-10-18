import { z } from 'zod';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ period: z.string() });

export const GET = api(async ({ actor, req }) => {
  const { period } = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().payroll.preview(actor, period);
});
