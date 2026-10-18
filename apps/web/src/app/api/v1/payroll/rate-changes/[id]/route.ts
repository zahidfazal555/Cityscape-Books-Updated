import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** The author (or `payroll = full`) withdraws a pending change. */
export const DELETE = api<{ id: string }>(async ({ actor, params }) => {
  await services().payroll.withdrawRate(actor, params.id);
});
