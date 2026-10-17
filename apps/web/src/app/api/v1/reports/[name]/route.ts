import { z } from 'zod';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const NAMES = ['income-expense', 'pnl', 'category', 'trial-balance'] as const;

/** FR-16 reports; each applies its own rights (P&L and trial balance need `pnl`). */
export const GET = api<{ name: string }>(async ({ actor, params }) => {
  const name = input(z.enum(NAMES), params.name);
  const r = services().reports;
  if (name === 'income-expense') return r.projectIncomeExpense(actor);
  if (name === 'pnl') return r.projectPnl(actor);
  if (name === 'category') return r.categoryPivot(actor);
  return r.trialBalance(actor);
});
