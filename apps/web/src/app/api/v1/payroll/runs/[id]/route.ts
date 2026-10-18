import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api<{ id: string }>(async ({ actor, params }) =>
  services().payroll.run(actor, params.id),
);
/** Withdraws a pending run, or (Owner only) reverses an approved one. */
export const DELETE = api<{ id: string }>(async ({ actor, params }) => {
  await services().payroll.removeRun(actor, params.id);
});
