import { z } from 'zod';
import type { MaterialPurchaseInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ projectId: z.string().uuid().optional() });

export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().inventory.list(actor, q);
});
/** "+ Record purchase" (FR-18.2). Posts nothing. */
export const POST = api(async ({ actor, body }) =>
  services().inventory.record(actor, body as MaterialPurchaseInput),
);
