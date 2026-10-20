import Link from 'next/link';
import {
  AGEING_BUCKETS,
  AGEING_LABEL,
  CATEGORY_LABEL,
  COST_CATEGORIES,
  type CostCategory,
} from '@csd/core';
import type { Dashboard, DashboardAlert, DashboardProject } from '@csd/services';
import { EmptyState } from '@/components/ui';
import { rupees } from '@/lib/format';
import { Donut, type DonutSlice } from './donut';

/**
 * Validated chart palette (dataviz reference, light): categorical slots in fixed order, a grey
 * "Other", and a one-hue blue ramp for ordered buckets. Checked with validate_palette.js.
 */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'] as const;
export const OTHER = '#8a94a6';
const AGE_RAMP = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'] as const;

/** Colour follows the category, never its rank: the five main ones keep a slot, the rest fold. */
export const CATEGORY_SLOT: Partial<Record<CostCategory, string>> = {
  material: SERIES[0],
  labour: SERIES[1],
  subcontract: SERIES[2],
  transport: SERIES[3],
  rent: SERIES[4],
};

/** README §2: amber `#FFF8EB`/`#F3DDAF` or red `#FEF3F2`/`#F6CFCB` banners. */
export function Alerts({ alerts }: { alerts: DashboardAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Alerts">
      {alerts.map((a) => (
        <li
          key={`${a.kind}:${a.href}`}
          className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-[13px] ${
            a.tone === 'red'
              ? 'border-danger-line bg-danger-bg text-danger'
              : 'border-warn-line bg-warn-bg text-warn'
          }`}
        >
          <span>{a.text}</span>
          <Link href={a.href} className="shrink-0 font-medium underline underline-offset-2">
            {a.kind === 'approvals' ? 'Review' : 'Open project'}
          </Link>
        </li>
      ))}
    </ul>
  );
}

type Accent = 'blue' | 'orange' | 'aqua' | 'violet' | 'green';
/** Card accents: a tinted icon and a top rule in the series hue; the number stays in ink. */
const ACCENT: Record<Accent, { bar: string; chip: string }> = {
  blue: { bar: 'bg-[#2a78d6]', chip: 'bg-[#e8f1fc] text-[#1c5cab]' },
  orange: { bar: 'bg-[#eb6834]', chip: 'bg-[#fdeee7] text-[#b8481d]' },
  aqua: { bar: 'bg-[#1baf7a]', chip: 'bg-[#e3f6ef] text-[#0f7d56]' },
  violet: { bar: 'bg-[#6250d6]', chip: 'bg-[#eeebfb] text-[#4a3aa7]' },
  green: { bar: 'bg-[#008300]', chip: 'bg-[#e3f3e3] text-[#006300]' },
};

const ICON: Record<string, string> = {
  in: 'M12 19V5m0 14-5-5m5 5 5-5',
  out: 'M12 5v14m0-14-5 5m5-5 5 5',
  bank: 'M3 10h18M5 10v8m4-8v8m6-8v8m4-8v8M3 21h18M12 3 3 8h18z',
  check: 'M9 12l2 2 4-4M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  rupee: 'M7 5h10M7 9h10M7 5c5 0 7 2 7 4s-2 4-7 4l7 6',
};

function Kpi({
  label,
  value,
  accent,
  icon,
}: {
  label: string;
  value: string;
  accent: Accent;
  icon: string;
}) {
  const a = ACCENT[accent];
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <span aria-hidden className={`absolute inset-x-0 top-0 h-1 ${a.bar}`} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <dt className="text-xs font-medium text-muted">{label}</dt>
          <dd className="num mt-1.5 text-[24px] font-semibold text-ink">{value}</dd>
        </div>
        <span
          aria-hidden
          className={`grid size-9 shrink-0 place-items-center rounded-lg ${a.chip}`}
        >
          <svg
            viewBox="0 0 24 24"
            className="size-[18px]"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={ICON[icon]} />
          </svg>
        </span>
      </div>
    </div>
  );
}

export function Kpis({ kpis }: { kpis: Dashboard['kpis'] }) {
  const items: { label: string; value: string; accent: Accent; icon: string }[] = [
    { label: 'Client receivables', value: rupees(kpis.receivables), accent: 'blue', icon: 'in' },
    { label: 'Vendor payables', value: rupees(kpis.payables), accent: 'orange', icon: 'out' },
  ];
  if (kpis.cashAndBank !== null)
    items.push({
      label: 'Cash & bank balance',
      value: rupees(kpis.cashAndBank),
      accent: 'aqua',
      icon: 'bank',
    });
  if (kpis.waitingApproval !== null)
    items.push({
      label: 'Waiting for your approval',
      value: String(kpis.waitingApproval),
      accent: 'violet',
      icon: 'check',
    });
  else if (kpis.collectedThisYear !== null)
    items.push({
      label: 'Collected this year',
      value: rupees(kpis.collectedThisYear),
      accent: 'green',
      icon: 'rupee',
    });
  return (
    <dl className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
      {items.map((k) => (
        <Kpi key={k.label} {...k} />
      ))}
    </dl>
  );
}

function BudgetBar({ p }: { p: DashboardProject }) {
  if (p.costBudget <= 0) return <span className="text-xs text-subtle">No budget</span>;
  const tone =
    p.level === 'red' ? 'bg-danger' : p.level === 'amber' ? 'bg-[#E0A030]' : 'bg-success';
  return (
    <span className="flex items-center gap-2">
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-track">
        <span
          className={`block h-full ${tone}`}
          style={{ width: `${Math.min(100, p.budgetUsedBp / 100)}%` }}
        />
      </span>
      <span className="num w-10 text-right text-xs">{Math.floor(p.budgetUsedBp / 100)}%</span>
    </span>
  );
}

const HEAD =
  'grid h-9 items-center gap-3 border-b border-divider bg-thead px-4 text-[11px] font-semibold uppercase tracking-[.05em] text-muted';

/**
 * Projects table: Net value only with `pnl` (the service leaves it out otherwise). Rows are real
 * table rows with cells; the project name is the link, stretched over the row (BUG-201).
 */
export function ProjectsTable({ projects }: { projects: DashboardProject[] }) {
  const pnl = projects.some((p) => p.net !== undefined);
  const cols = pnl ? '32px 2.2fr 1fr 1fr 1fr 1fr 1.3fr' : '32px 2.2fr 1fr 1fr 1fr 1.3fr';
  if (projects.length === 0) return <EmptyState>No active projects yet.</EmptyState>;
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white">
      <div role="table" aria-label="Projects" className="min-w-[760px] text-[13px]">
        <div role="row" className={HEAD} style={{ gridTemplateColumns: cols }}>
          <span role="columnheader">#</span>
          <span role="columnheader">Project</span>
          <span role="columnheader" className="text-right">
            Invoice value
          </span>
          <span role="columnheader" className="text-right">
            Income · Cr
          </span>
          <span role="columnheader" className="text-right">
            Expense · Dr
          </span>
          {pnl ? (
            <span role="columnheader" className="text-right">
              Net value
            </span>
          ) : null}
          <span role="columnheader">Budget used</span>
        </div>
        {projects.map((p, i) => (
          <div
            key={p.projectId}
            role="row"
            className="relative grid min-h-[48px] items-center gap-3 border-b border-divider px-4 py-2 last:border-b-0 hover:bg-thead"
            style={{ gridTemplateColumns: cols }}
          >
            <span role="cell" className="num text-muted">
              {i + 1}
            </span>
            <span role="cell" className="min-w-0">
              <Link
                href={`/projects/${p.projectId}`}
                className="block truncate font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-primary"
              >
                {p.name}
              </Link>
              <span className="font-mono text-[11.5px] text-muted">{p.code}</span>
              <span className="text-[12px] text-muted"> · {p.clientName}</span>
            </span>
            <span role="cell" className="num text-right">
              {rupees(p.invoiceValue)}
            </span>
            <span role="cell" className="num text-right text-success">
              {rupees(p.income)}
            </span>
            <span role="cell" className="num text-right text-danger">
              {rupees(p.expense)}
            </span>
            {pnl ? (
              <span
                role="cell"
                className={`num text-right font-medium ${(p.net ?? 0) < 0 ? 'text-danger' : ''}`}
              >
                {rupees(p.net ?? 0)}
              </span>
            ) : null}
            <span role="cell">
              <BudgetBar p={p} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** README §2 spend by category: the five main categories, the rest as "Other". */
export function SpendByCategory({ spend }: { spend: Dashboard['spendByCategory'] }) {
  const main = COST_CATEGORIES.filter((c) => CATEGORY_SLOT[c]);
  const other = COST_CATEGORIES.filter((c) => !CATEGORY_SLOT[c]).reduce(
    (n, c) => n + Math.max(0, spend[c]),
    0,
  );
  const slices: DonutSlice[] = [
    ...main.map((c) => ({
      key: c,
      label: CATEGORY_LABEL[c],
      amount: Math.max(0, spend[c]),
      colour: CATEGORY_SLOT[c] ?? OTHER,
      href: `/spend/${c}`,
    })),
    {
      key: 'other',
      label: 'Other categories',
      amount: other,
      colour: OTHER,
      href: '/spend/other',
    },
  ];
  return (
    <Donut
      title="Spend by category"
      slices={slices}
      totalLabel="Total spend"
      empty="No approved spending yet."
    />
  );
}

/** Where the money goes: expense per active project, the five largest and "Other". */
export function SpendByProject({ projects }: { projects: DashboardProject[] }) {
  const sorted = [...projects].filter((p) => p.expense > 0).sort((a, b) => b.expense - a.expense);
  const top = sorted.slice(0, 5);
  const rest = sorted.slice(5).reduce((n, p) => n + p.expense, 0);
  const slices: DonutSlice[] = [
    ...top.map((p, i) => ({
      key: p.projectId,
      label: `${p.code} · ${p.name}`,
      amount: p.expense,
      colour: SERIES[i] ?? OTHER,
      href: `/projects/${p.projectId}`,
    })),
    { key: 'other', label: 'Other projects', amount: rest, colour: OTHER, href: '/projects' },
  ];
  return (
    <Donut
      title="Spend by project"
      slices={slices}
      totalLabel="Active projects"
      empty="No spending on active projects yet."
    />
  );
}

/** Receivables ageing (Current / 1–30 / 31–60 / 61–90 / 90+), older = darker on one blue ramp. */
export function ReceivablesAgeing({ ageing }: { ageing: Dashboard['ageing'] }) {
  const slices: DonutSlice[] = AGEING_BUCKETS.map((b, i) => ({
    key: b,
    label: b === 'current' ? 'Not yet due' : `${AGEING_LABEL[b]} days overdue`,
    amount: Math.max(0, ageing[b]),
    colour: AGE_RAMP[i] ?? OTHER,
    href: `/outstanding?bucket=${b}`,
  }));
  return (
    <Donut
      title="Receivables by age"
      slices={slices}
      totalLabel="Receivables"
      empty="Nothing receivable right now."
    />
  );
}
