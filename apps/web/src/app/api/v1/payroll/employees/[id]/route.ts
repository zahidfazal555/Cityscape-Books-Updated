import type { EmployeeUpdate } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Everything but the rate (which goes through /rate, H2). */
export const PATCH = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().payroll.updateEmployee(actor, params.id, body as EmployeeUpdate);
});
