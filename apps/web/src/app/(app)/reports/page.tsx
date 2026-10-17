import {
  CATEGORY_LABEL,
  COST_CATEGORIES,
  can,
  formatDate,
  parseIsoDate,
  projectScope,
  todayIn,
  type Actor,
} from '@csd/core';
import type { ProjectFigures } from '@csd/services';
import { PageHeader, Row, Table } from '@/components/kit';
import { DownloadLink, LinkTabs } from '@/components/accounts/tabs';
import { EmptyState } from '@/components/ui';
import { rupees } from '@/lib/format';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';

type Tab = 'income-expense' | 'pnl' | 'category' | 'trial-balance';

/** README §13: P&L for `pnl`; trial balance for the Owner or `pnl` with all projects. */
function tabsFor(actor: Actor): { value: Tab; label: string; href: string }[] {
  const pnl = can(actor, 'pnl', 'view');
  const tb = (actor.role === 'owner' || pnl) && projectScope(actor) === null;
  return [
    { value: 'income-expense' as const, label: 'Project income & expenses', href: '/reports' },
    ...(pnl
      ? [{ value: 'pnl' as const, label: 'Project profit & loss', href: '/reports?tab=pnl' }]
      : []),
    { value: 'category' as const, label: 'Spend by category', href: '/reports?tab=category' },
    ...(tb
      ? [
          {
            value: 'trial-balance' as const,
            label: 'Trial balance',
            href: '/reports?tab=trial-balance',
          },
        ]
      : []),
  ];
}

/** A real date from the URL, or undefined (BUG-137). */
function validDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    parseIsoDate(raw);
    return raw;
  } catch {
    return undefined;
  }
}

const pct = (m: number | null | undefined) =>
  m === null || m === undefined ? '—' : `${(m * 100).toFixed(1)}%`;

function ProjectTable({ rows, withProfit }: { rows: ProjectFigures[]; withProfit: boolean }) {
  if (rows.length === 0) return <EmptyState>No projects yet.</EmptyState>;
  return (
    <Table
      columns={`0.9fr 2fr 1fr 1fr 1fr 0.8fr${withProfit ? ' 1fr 0.7fr' : ''}`}
      minWidth={withProfit ? 1080 : 860}
    >
      <Row head>
        <span>Project</span>
        <span>Name · client</span>
        <span className="text-right">Revenue</span>
        <span className="text-right">Cost</span>
        <span className="text-right">Budget</span>
        <span className="text-right">Budget used</span>
        {withProfit ? <span className="text-right">Profit</span> : null}
        {withProfit ? <span className="text-right">Margin</span> : null}
      </Row>
      {rows.map((r) => (
        <Row key={r.projectId}>
          <span className="font-mono text-[12px]">{r.code}</span>
          <span className="min-w-0">
            <span className="block truncate">{r.name}</span>
            <span className="block truncate text-xs text-muted">{r.clientName}</span>
          </span>
          <span className="num text-right">{rupees(r.revenue)}</span>
          <span className="num text-right">{rupees(r.cost)}</span>
          <span className="num text-right">{rupees(r.costBudget)}</span>
          <span
            className={`num text-right ${r.budgetUsedBp > 10_000 ? 'text-danger' : r.budgetUsedBp >= 8_500 ? 'text-warn' : ''}`}
          >
            {(r.budgetUsedBp / 100).toFixed(0)}%
          </span>
          {withProfit ? (
            <span className={`num text-right ${(r.profit ?? 0) < 0 ? 'text-danger' : ''}`}>
              {rupees(r.profit ?? 0)}
            </span>
          ) : null}
          {withProfit ? <span className="num text-right">{pct(r.margin)}</span> : null}
        </Row>
      ))}
    </Table>
  );
}

async function body(actor: Actor, tab: Tab, asOf: string) {
  const r = services().reports;
  if (tab === 'pnl') return <ProjectTable rows={await r.projectPnl(actor)} withProfit />;
  if (tab === 'income-expense') {
    const rows = await r.projectIncomeExpense(actor);
    return <ProjectTable rows={rows} withProfit={rows.some((x) => x.profit !== undefined)} />;
  }
  if (tab === 'category') {
    const p = await r.categoryPivot(actor);
    if (p.projects.length === 0) return <EmptyState>No spending yet.</EmptyState>;
    return (
      <Table columns={`0.9fr repeat(${COST_CATEGORIES.length}, 0.9fr) 1fr`} minWidth={1300}>
        <Row head>
          <span>Project</span>
          {COST_CATEGORIES.map((c) => (
            <span key={c} className="text-right">
              {CATEGORY_LABEL[c]}
            </span>
          ))}
          <span className="text-right">Total</span>
        </Row>
        {p.projects.map((x) => (
          <Row key={x.projectId}>
            <span className="font-mono text-[12px]">{x.code}</span>
            {COST_CATEGORIES.map((c) => (
              <span key={c} className="num text-right">
                {x.byCategory[c] ? rupees(x.byCategory[c]) : ''}
              </span>
            ))}
            <span className="num text-right font-medium">{rupees(x.total)}</span>
          </Row>
        ))}
        <Row>
          <span className="font-semibold">Total</span>
          {COST_CATEGORIES.map((c) => (
            <span key={c} className="num text-right font-semibold">
              {p.totals[c] ? rupees(p.totals[c]) : ''}
            </span>
          ))}
          <span className="num text-right font-semibold">
            {rupees(COST_CATEGORIES.reduce((n, c) => n + p.totals[c], 0))}
          </span>
        </Row>
      </Table>
    );
  }
  const tb = await r.trialBalance(actor, asOf);
  return (
    <div className="flex flex-col gap-3">
      <form method="get" className="flex flex-wrap items-end gap-2 text-[13px]">
        <input type="hidden" name="tab" value="trial-balance" />
        <label className="flex flex-col gap-1">
          <span className="text-muted">As at</span>
          <input
            type="date"
            name="asOf"
            defaultValue={asOf}
            className="h-9 rounded-md border border-line bg-white px-2"
          />
        </label>
        <button type="submit" className="h-9 rounded-md border border-line bg-white px-3">
          Show
        </button>
        <span className="self-center text-muted">Balances as at {formatDate(tb.asOf)}</span>
      </form>
      <p
        role="status"
        className={`rounded-md px-3 py-2 text-[13px] font-medium ${tb.balanced ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger'}`}
      >
        {tb.balanced ? 'Debits equal credits' : 'Out of balance'}: {rupees(tb.debit)} /{' '}
        {rupees(tb.credit)}
      </p>
      <Table columns="0.6fr 2fr 0.8fr 1fr 1fr" minWidth={720}>
        <Row head>
          <span>Code</span>
          <span>Account</span>
          <span>Type</span>
          <span className="text-right">Debit</span>
          <span className="text-right">Credit</span>
        </Row>
        {tb.rows.map((a) => (
          <Row key={a.code}>
            <span className="font-mono text-[12px]">{a.code}</span>
            <span>{a.name}</span>
            <span className="text-muted">{a.type}</span>
            <span className="num text-right">{a.debit ? rupees(a.debit) : ''}</span>
            <span className="num text-right">{a.credit ? rupees(a.credit) : ''}</span>
          </Row>
        ))}
      </Table>
    </div>
  );
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; asOf?: string }>;
}) {
  const { actor } = await getSession();
  if (!can(actor, 'reports', 'view'))
    return <EmptyState>You do not have access to reports.</EmptyState>;
  const tabs = tabsFor(actor);
  const sp = await searchParams;
  const tab = tabs.find((t) => t.value === sp.tab)?.value ?? 'income-expense';
  const asOf = validDate(sp.asOf) ?? todayIn();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Reports"
        subtitle="From the books: approved entries only."
        action={
          <DownloadLink
            href={`/api/v1/reports/${tab}/export${tab === 'trial-balance' ? `?asOf=${asOf}` : ''}`}
          >
            Export this report (CSV)
          </DownloadLink>
        }
      />
      <LinkTabs value={tab} items={tabs} />
      {await body(actor, tab, asOf)}
    </div>
  );
}
