import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  CATEGORY_LABEL,
  COST_CATEGORIES,
  can,
  formatDate,
  isUuid,
  type CostCategory,
} from '@csd/core';
import { CATEGORY_SLOT, OTHER } from '@/components/dashboard/dashboard-view';
import { PageHeader, Row, Table } from '@/components/kit';
import { EmptyState } from '@/components/ui';
import type { SpendDetail } from '@csd/services';
import { rupees } from '@/lib/format';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';

/** The categories folded into "Other categories" on the dashboard donut. */
const FOLDED = COST_CATEGORIES.filter((c) => !CATEGORY_SLOT[c]);
const colourOf = (c: CostCategory) => CATEGORY_SLOT[c] ?? OTHER;
const pct = (part: number, total: number) =>
  total <= 0 ? '0%' : `${Math.round((part / total) * 100)}%`;

/** A share bar: the slice's colour on a light track, value and share beside it. */
function ShareBar({
  label,
  href,
  amount,
  total,
  colour,
}: {
  label: string;
  href?: string;
  amount: number;
  total: number;
  colour: string;
}) {
  return (
    <li className="grid grid-cols-[minmax(140px,1.2fr)_2fr_auto] items-center gap-3 text-[13px]">
      {href ? (
        <Link href={href} className="truncate text-body hover:text-primary hover:underline">
          {label}
        </Link>
      ) : (
        <span className="truncate text-body">{label}</span>
      )}
      <span className="h-2.5 overflow-hidden rounded-full bg-track">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${total > 0 ? Math.max(1, (amount / total) * 100) : 0}%`,
            background: colour,
          }}
        />
      </span>
      <span className="num min-w-[130px] text-right">
        {rupees(amount)} <span className="text-muted">· {pct(amount, total)}</span>
      </span>
    </li>
  );
}

/** By category (for "Other categories") and by project, as share bars. */
function Breakdown({
  d,
  single,
  colour,
}: {
  d: SpendDetail;
  single: CostCategory | undefined;
  colour: string;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {single ? null : (
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="mb-3 text-[15px] font-semibold">By category</h2>
          <ul className="flex flex-col gap-2.5">
            {d.byCategory.map((c) => (
              <ShareBar
                key={c.category}
                label={CATEGORY_LABEL[c.category]}
                amount={c.amount}
                total={d.total}
                colour={OTHER}
              />
            ))}
          </ul>
        </section>
      )}
      <section className="rounded-xl border border-line bg-white p-4">
        <h2 className="mb-3 text-[15px] font-semibold">By project</h2>
        <ul className="flex flex-col gap-2.5">
          {d.byProject.map((p) => (
            <ShareBar
              key={p.projectId}
              label={`${p.code} · ${p.name}`}
              href={`/projects/${p.projectId}`}
              amount={p.amount}
              total={d.total}
              colour={colour}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Every posting behind the total, newest first. */
function Entries({ d, single }: { d: SpendDetail; single: CostCategory | undefined }) {
  return (
    <section>
      <h2 className="mb-2 text-[15px] font-semibold">Entries</h2>
      <Table columns={single ? '110px 3fr 1.3fr 1fr' : '110px 3fr 1.2fr 1.3fr 1fr'}>
        <Row head>
          <span>Date</span>
          <span>Particulars</span>
          {single ? null : <span>Category</span>}
          <span>Project</span>
          <span className="text-right">Amount</span>
        </Row>
        {d.entries.map((e, i) => (
          <Row key={i}>
            <span className="text-muted">{formatDate(e.date)}</span>
            <span className="truncate">{e.particulars}</span>
            {single ? null : <span className="text-muted">{CATEGORY_LABEL[e.category]}</span>}
            <Link
              href={`/projects/${e.projectId}`}
              className="font-mono text-[12px] text-primary hover:underline"
            >
              {e.projectCode}
            </Link>
            <span className={`num text-right ${e.amount < 0 ? 'text-danger' : ''}`}>
              {rupees(e.amount)}
            </span>
          </Row>
        ))}
      </Table>
      {d.truncated ? (
        <p className="mt-2 text-xs text-muted">
          Showing the latest {d.entries.length} entries; the totals above include older ones too.
        </p>
      ) : null}
    </section>
  );
}

/** Back to the project when the drill-down came from a project page, else to the dashboard. */
function backLink(projectId: string | undefined, p: SpendDetail['byProject'][number] | undefined) {
  if (!projectId) return { href: '/', label: '← Dashboard', code: '' };
  return {
    href: `/projects/${projectId}`,
    label: `← ${p ? `${p.code} · ${p.name}` : 'Project'}`,
    code: p ? ` · ${p.code}` : '',
  };
}

/** Drill-down from the dashboard's "Spend by category" donut: by project, then every entry. */
export default async function SpendPage({
  params,
  searchParams,
}: {
  params: Promise<{ category: string }>;
  searchParams: Promise<{ project?: string }>;
}) {
  const { actor } = await getSession();
  if (actor.role === 'site') redirect('/site');
  if (!can(actor, 'dashboard', 'view')) return <EmptyState>Your role has no dashboard.</EmptyState>;
  const { category } = await params;
  const cats: CostCategory[] =
    category === 'other'
      ? FOLDED
      : COST_CATEGORIES.filter((c) => c === category && CATEGORY_SLOT[c]);
  if (cats.length === 0) notFound();
  // ?project= narrows the drill-down to one project (from the project page's donut).
  const { project } = await searchParams;
  const projectId = project && isUuid(project) ? project : undefined;
  const d = await services().dashboard.spend(actor, cats, projectId);
  const back = backLink(projectId, d.byProject[0]);
  const single = cats.length === 1 ? cats[0] : undefined;
  const colour = single ? colourOf(single) : OTHER;
  const title = single ? CATEGORY_LABEL[single] : 'Other categories';
  return (
    <div className="flex flex-col gap-4">
      <Link href={back.href} className="text-[13px] text-muted hover:text-primary">
        {back.label}
      </Link>
      <PageHeader
        title={`Spend · ${title}${back.code}`}
        subtitle={
          single
            ? 'Approved spending posted to this category, on the projects you can see.'
            : `${cats.map((c) => CATEGORY_LABEL[c]).join(', ')}: approved spending on the projects you can see.`
        }
      />
      <section className="relative overflow-hidden rounded-xl border border-line bg-white p-4">
        <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: colour }} />
        <div className="text-xs font-medium text-muted">Total spend</div>
        <div className="num mt-1 text-[26px] font-semibold text-ink">{rupees(d.total)}</div>
        <div className="text-[12px] text-muted">
          {d.byProject.length} {d.byProject.length === 1 ? 'project' : 'projects'} ·{' '}
          {d.entries.length}
          {d.truncated ? '+' : ''} {d.entries.length === 1 ? 'entry' : 'entries'}
        </div>
      </section>
      {d.total === 0 && d.entries.length === 0 ? (
        <EmptyState>No approved spending in this category yet.</EmptyState>
      ) : (
        <>
          <Breakdown d={d} single={single} colour={colour} />
          <Entries d={d} single={single} />
        </>
      )}
    </div>
  );
}
