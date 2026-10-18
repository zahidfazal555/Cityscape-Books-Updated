import type { ExpenseInput } from '@csd/services';
import { api } from '@/lib/http';
import { expenseQuery, input } from '@/lib/schemas';
import { services } from '@/lib/server';

export const GET = api(async ({ actor, req }) => {
  const q = input(expenseQuery, Object.fromEntries(req.nextUrl.searchParams));
  return services().expenses.list(actor, q);
});
/** Pending for everyone but the Owner (H2). */
export const POST = api(async ({ actor, body }) =>
  services().expenses.create(actor, body as ExpenseInput),
);
