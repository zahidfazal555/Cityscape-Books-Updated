import { z } from 'zod';
import type { EmployeeInput } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ kind: z.enum(['salaried', 'daily']).default('salaried') });

export const GET = api(async ({ actor, req }) => {
  const { kind } = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().payroll.employees(actor, kind);
});
/** H2: a non-owner's salary or daily rate waits for the Owner. */
export const POST = api(async ({ actor, body }) =>
  services().payroll.createEmployee(actor, body as EmployeeInput),
);
