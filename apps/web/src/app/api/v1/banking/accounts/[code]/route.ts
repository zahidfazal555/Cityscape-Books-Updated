import { z } from 'zod';
import { MONEY_ACCOUNTS, type MoneyAccount } from '@csd/services';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ from: z.string().optional(), to: z.string().optional() });

/** One account's register with a running balance (FR-13.2). */
export const GET = api<{ code: string }>(async ({ actor, params, req }) => {
  const code = input(z.enum(MONEY_ACCOUNTS), params.code) as MoneyAccount;
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  return services().banking.register(actor, code, q);
});
