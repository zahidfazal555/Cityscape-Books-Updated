import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Withdraws a pending advance, or (Owner only) reverses an unrecovered approved one. */
export const DELETE = api<{ id: string }>(async ({ actor, params }) => {
  await services().payroll.removeAdvance(actor, params.id);
});
