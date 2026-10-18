import type { PoUpdate } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api<{ id: string }>(async ({ actor, params }) =>
  services().purchaseOrders.get(actor, params.id),
);
/** Drafts only. */
export const PATCH = api<{ id: string }>(async ({ actor, params, body }) => {
  await services().purchaseOrders.update(actor, params.id, body as PoUpdate);
});
/** Drafts only, `pos = full` (FR-9.3). */
export const DELETE = api<{ id: string }>(async ({ actor, params }) => {
  await services().purchaseOrders.remove(actor, params.id);
});
