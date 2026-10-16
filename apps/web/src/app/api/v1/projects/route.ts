import { z } from 'zod';
import { PROJECT_STATUSES, type ProjectInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ status: z.enum(PROJECT_STATUSES).optional() });

export const GET = api(async ({ actor, req }) => {
  const { status } = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().projects.list(actor, status);
});
export const POST = api(async ({ actor, body }) =>
  services().projects.create(actor, body as ProjectInput),
);
