import { z } from 'zod';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ date: z.string() });

/** "+1" (FR-17.2): a full or half day, today unless a date is given. */
export const POST = api<{ id: string }>(async ({ actor, params, body }) =>
  services().labour.markAttendance(
    actor,
    params.id,
    (body ?? {}) as { workDate?: string; tenths?: 5 | 10 },
  ),
);
export const DELETE = api<{ id: string }>(async ({ actor, params, req }) => {
  const { date } = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().labour.unmarkAttendance(actor, params.id, date);
});
