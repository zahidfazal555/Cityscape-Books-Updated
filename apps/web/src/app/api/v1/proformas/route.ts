import { z } from 'zod';
import { PROFORMA_STATUSES, type ProformaInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({
  projectId: z.string().uuid().optional(),
  status: z.enum(PROFORMA_STATUSES).optional(),
});

export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().proformas.list(actor, { projectId: q.projectId, status: q.status });
});
export const POST = api(async ({ actor, body }) =>
  services().proformas.create(actor, body as ProformaInput),
);
