import Link from 'next/link';
import { AGEING_BUCKETS, AGEING_LABEL, CATEGORY_LABEL, COST_CATEGORIES } from '@csd/core';
import type { Dashboard, DashboardAlert, DashboardProject } from '@csd/services';
import { EmptyState } from '@/components/ui';
import { rupees } from '@/lib/format';

/** One colour per cost category, in COST_CATEGORIES order. */
const CATEGORY_COLOUR = [
  '#1F5FAE',
  '#2E9D8F',
  '#E0A030',
  '#7A5AF8',
  '#D9534F',
  '#5B6573',
  '#3BA3E6',
  '#A3B83A',
  '#C76BA6',
];

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

export function Kpis({ kpis }: { kpis: Dashboard['kpis'] }) {
  const items: [string, string][] = [
    ['Client receivables', rupees(kpis.receivables)],
    ['Vendor payables', rupees(kpis.payables)],
  ];
  if (kpis.cashAndBank !== null) items.push(['Cash & bank balance', rupees(kpis.cashAndBank)]);
  if (kpis.waitingApproval !== null)
    items.push(['Waiting for your approval', String(kpis.waitingApproval)]);
  else if (kpis.collectedThisYear !== null)
    items.push(['Collected this year', rupees(kpis.collectedThisYear)]);
  return (
    <dl className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
      {items.map(([k, v]) => (
        <div key={k} className="rounded-lg border border-line bg-white p-4">
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="num mt-1 text-[22px] font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function BudgetBar({ bp, hasBudget }: { bp: number; hasBudget: boolean }) {
  if (!hasBudget) return <span className="text-xs text-subtle">No budget</span>;
  const tone = bp > 10_000 ? 'bg-danger' : bp >= 8_500 ? 'bg-[#E0A030]' : 'bg-success';
  return (
    <span className="flex items-center gap-2">
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-track">
        <span className={`block h-full ${tone}`} style={{ width: `${Math.min(100, bp / 100)}%` }} />
      </span>
      <span className="num w-10 text-right text-xs">{Math.round(bp / 100)}%</span>
    </span>
  );
}

/** Projects table: Net value only with `pnl` (the service leaves it out otherwise). */
export function ProjectsTable({ projects }: { projects: DashboardProject[] }) {
  const pnl = projects.some((p) => p.net !== undefined);
  const cols = pnl ? '32px 2.2fr 1fr 1fr 1fr 1fr 1.3fr' : '32px 2.2fr 1fr 1fr 1fr 1.3fr';
  if (projects.length === 0) return <EmptyState>No active projects yet.</EmptyState>;
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white">
      <div role="table" aria-label="Projects" className="min-w-[760px] text-[13px]">
        <div
          role="row"
          className="grid h-9 items-center gap-3 border-b border-divider bg-thead px-4 text-[11px] font-semibold uppercase tracking-[.05em] text-muted"
          style={{ gridTemplateColumns: cols }}
        >
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
          <Link
            key={p.projectId}
            role="row"
            href={`/projects/${p.projectId}`}
            className="grid min-h-[48px] items-center gap-3 border-b border-divider px-4 py-2 last:border-b-0 hover:bg-thead"
            style={{ gridTemplateColumns: cols }}
          >
            <span className="num text-muted">{i + 1}</span>
            <span className="min-w-0">
              <span className="block truncate font-medium">{p.name}</span>
              <span className="font-mono text-[11.5px] text-muted">{p.code}</span>
              <span className="text-[12px] text-muted"> · {p.clientName}</span>
            </span>
            <span className="num text-right">{rupees(p.invoiceValue)}</span>
            <span className="num text-right text-success">{rupees(p.income)}</span>
            <span className="num text-right text-danger">{rupees(p.expense)}</span>
            {pnl ? (
              <span
                className={`num text-right font-medium ${(p.net ?? 0) < 0 ? 'text-danger' : ''}`}
              >
                {rupees(p.net ?? 0)}
              </span>
            ) : null}
            <BudgetBar bp={p.budgetUsedBp} hasBudget={p.costBudget > 0} />
          </Link>
        ))}
      </div>
    </div>
  );
}

/** README §2: a conic-gradient donut (150px, 96px hole) with a legend. */
export function SpendDonut({ spend }: { spend: Dashboard['spendByCategory'] }) {
  const parts = COST_CATEGORIES.map((cat, i) => ({
    cat,
    amount: Math.max(0, spend[cat]),
    colour: CATEGORY_COLOUR[i] ?? '#8A94A6',
  })).filter((p) => p.amount > 0);
  const total = parts.reduce((s, p) => s + p.amount, 0);
  let at = 0;
  const stops = parts.map((p) => {
    const from = at;
    at += (p.amount / total) * 100;
    return `${p.colour} ${from}% ${at}%`;
  });
  return (
    <section className="rounded-lg border border-line bg-white p-4">
      <h2 className="mb-3 text-[15px] font-semibold">Spend by category</h2>
      {total === 0 ? (
        <p className="text-[13px] text-muted">No approved spending yet.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          <div
            role="img"
            aria-label={`Spend by category, total ${rupees(total)}`}
            className="relative size-[150px] shrink-0 rounded-full"
            style={{ background: `conic-gradient(${stops.join(', ')})` }}
          >
            <span className="absolute left-1/2 top-1/2 flex size-[96px] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full bg-white">
              <span className="text-[11px] text-muted">Total</span>
              <span className="num text-[13px] font-semibold">{rupees(total)}</span>
            </span>
          </div>
          <ul className="flex min-w-[200px] flex-1 flex-col gap-1.5 text-[13px]">
            {parts.map((p) => (
              <li key={p.cat} className="flex items-center gap-2">
                <span className="size-2.5 rounded-sm" style={{ background: p.colour }} />
                <span className="flex-1">{CATEGORY_LABEL[p.cat]}</span>
                <span className="num">{rupees(p.amount)}</span>
                <span className="num w-10 text-right text-muted">
                  {Math.round((p.amount / total) * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Receivables ageing: Current / 1–30 / 31–60 / 61–90 / 90+. */
export function AgeingBars({ ageing }: { ageing: Dashboard['ageing'] }) {
  const max = Math.max(1, ...AGEING_BUCKETS.map((b) => ageing[b]));
  return (
    <section className="rounded-lg border border-line bg-white p-4">
      <h2 className="mb-3 text-[15px] font-semibold">Receivables ageing (days overdue)</h2>
      <ul className="flex flex-col gap-2.5 text-[13px]">
        {AGEING_BUCKETS.map((b) => (
          <li key={b} className="grid grid-cols-[64px_1fr_auto] items-center gap-3">
            <span className="text-muted">{AGEING_LABEL[b]}</span>
            <span className="h-2.5 overflow-hidden rounded-full bg-track">
              <span
                className={`block h-full ${b === 'current' ? 'bg-primary' : b === 'd90_plus' || b === 'd61_90' ? 'bg-danger' : 'bg-[#E0A030]'}`}
                style={{ width: `${(ageing[b] / max) * 100}%` }}
              />
            </span>
            <span className="num min-w-[88px] text-right">{rupees(ageing[b])}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
