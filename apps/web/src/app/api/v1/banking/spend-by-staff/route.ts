import { z } from 'zod';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ from: z.string().optional(), to: z.string().optional() });

/** FR-13.3: approved spends by paid-by label and mode. */
export const GET = api(async ({ actor, req }) =>
  services().banking.spendByStaff(
    actor,
    input(query, Object.fromEntries(req.nextUrl.searchParams)),
  ),
);
