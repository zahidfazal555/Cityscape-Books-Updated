import { z } from 'zod';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

/** Ticks or unticks a register line as matched with the statement. */
export const POST = api<{ id: string }>(async ({ actor, params, body }) => {
  const { matched } = input(z.object({ matched: z.boolean() }), body);
  await services().banking.setMatched(actor, params.id, matched);
});
