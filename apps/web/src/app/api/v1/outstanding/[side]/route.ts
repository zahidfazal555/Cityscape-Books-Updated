import { z } from 'zod';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

/** Client receivables or vendor payables with ageing (FR-14). */
export const GET = api<{ side: string }>(async ({ actor, params }) => {
  const side = input(z.enum(['receivables', 'payables']), params.side);
  const s = services().outstanding;
  return side === 'receivables' ? s.receivables(actor) : s.payables(actor);
});
