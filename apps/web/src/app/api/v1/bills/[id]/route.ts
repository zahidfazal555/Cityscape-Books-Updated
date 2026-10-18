import type { BillUpdate } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api<{ id: string }>(async ({ actor, params }) =>
  services().bills.get(actor, params.id),
);
/** Open period only; never below what is paid or pending (FR-10.4). */
export const PATCH = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().bills.update(actor, params.id, body as BillUpdate);
});
/** Unpaid bills only, `bills = full`. */
export const DELETE = api<{ id: string }>(async ({ actor, params }) => {
  await services().bills.remove(actor, params.id);
});
