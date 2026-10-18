import { z } from 'zod';
import { CATEGORY_LABEL, COST_CATEGORIES, toDecimalString } from '@csd/core';
import type { Actor } from '@csd/core';
import { csvResponse } from '@/lib/csv-response';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const NAMES = ['income-expense', 'pnl', 'category', 'trial-balance'] as const;
type Name = (typeof NAMES)[number];
const d = toDecimalString;

async function rowsFor(actor: Actor, name: Name, asOf?: string): Promise<(string | number)[][]> {
  const r = services().reports;
  if (name === 'category') {
    const p = await r.categoryPivot(actor);
    return [
      ['Project', ...COST_CATEGORIES.map((c) => CATEGORY_LABEL[c]), 'Total'],
      ...p.projects.map((x) => [
        x.code,
        ...COST_CATEGORIES.map((c) => d(x.byCategory[c])),
        d(x.total),
      ]),
      [
        'Total',
        ...COST_CATEGORIES.map((c) => d(p.totals[c])),
        d(COST_CATEGORIES.reduce((n, c) => n + p.totals[c], 0)),
      ],
    ];
  }
  if (name === 'trial-balance') {
    const t = await r.trialBalance(actor, asOf);
    return [
      ['Code', 'Account', 'Type', 'Debit', 'Credit'],
      ...t.rows.map((x) => [x.code, x.name, x.type, d(x.debit), d(x.credit)]),
    ];
  }
  const list = name === 'pnl' ? await r.projectPnl(actor) : await r.projectIncomeExpense(actor);
  const withProfit = list.some((x) => x.profit !== undefined);
  return [
    [
      'Project',
      'Name',
      'Client',
      'Contract',
      'Revenue',
      'Cost',
      'Budget',
      ...(withProfit ? ['Profit', 'Margin %'] : []),
    ],
    ...list.map((x) => [
      x.code,
      x.name,
      x.clientName,
      d(x.contractValue),
      d(x.revenue),
      d(x.cost),
      d(x.costBudget),
      ...(withProfit
        ? [
            d(x.profit ?? 0),
            x.margin === null || x.margin === undefined ? '' : (x.margin * 100).toFixed(1),
          ]
        : []),
    ]),
  ];
}

/** "Export this report (CSV)" (FR-16.4), audited (H4). */
const query = z.object({ asOf: z.string().optional() });

export const GET = api<{ name: string }>(async ({ actor, params, req }) => {
  const name = input(z.enum(NAMES), params.name);
  const { asOf } = input(query, Object.fromEntries(req.nextUrl.searchParams));
  const rows = await rowsFor(actor, name, asOf);
  await services().reports.recordExport(actor, name, rows.length - 1);
  return csvResponse(`report-${name}`, rows);
});
