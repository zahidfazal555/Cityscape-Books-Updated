import type { ExpenseUpdate } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api<{ id: string }>(async ({ actor, params }) =>
  services().expenses.get(actor, params.id),
);
export const PATCH = api<{ id: string }>(async ({ actor, params, body }) =>
  services().expenses.update(actor, params.id, body as ExpenseUpdate),
);
export const DELETE = api<{ id: string }>(async ({ actor, params }) => {
  await services().expenses.remove(actor, params.id);
});
