import { z } from 'zod';
import { CATEGORY_LABEL, COST_CATEGORIES, formatDate, toDecimalString, todayIn } from '@csd/core';
import type { Actor } from '@csd/core';
import { exportFormat, exportResponse } from '@/lib/export-response';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const NAMES = ['income-expense', 'pnl', 'category', 'trial-balance'] as const;
type Name = (typeof NAMES)[number];
const d = toDecimalString;
const TITLE: Record<Name, string> = {
  'income-expense': 'Project income & expenses',
  pnl: 'Project profit & loss',
  category: 'Spend by category',
  'trial-balance': 'Trial balance',
};

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

/** "Export this report" as CSV (FR-16.4) or PDF (Tech Spec §11), audited (H4). */
const query = z.object({ asOf: z.string().optional() }).merge(exportFormat);

export const GET = api<{ name: string }>(async ({ actor, params, req }) => {
  const name = input(z.enum(NAMES), params.name);
  const { asOf, format } = input(query, Object.fromEntries(req.nextUrl.searchParams));
  const rows = await rowsFor(actor, name, asOf);
  await services().reports.recordExport(actor, name, rows.length - 1, format);
  const subtitle = name === 'trial-balance' ? `As on ${formatDate(asOf ?? todayIn())}` : undefined;
  return exportResponse(actor, format, `report-${name}`, { title: TITLE[name], subtitle }, rows);
});
