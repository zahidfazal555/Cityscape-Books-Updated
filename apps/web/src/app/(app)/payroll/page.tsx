import { can, projectScope, todayIn } from '@csd/core';
import { PageHeader } from '@/components/kit';
import { LinkTabs } from '@/components/accounts/tabs';
import { EmptyState } from '@/components/ui';
import { projectOptions } from '@/lib/purchase-options';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { ContractsView } from './contracts-view';
import { LabourView } from './labour-view';
import { StaffView, type PayrollRights } from './staff-view';

type Tab = 'staff' | 'labour' | 'contracts';

const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** README §14 Payroll: monthly staff, daily-wage labour and contractors. */
export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; period?: string }>;
}) {
  const { actor, company } = await getSession();
  if (!can(actor, 'payroll', 'view'))
    return <EmptyState>You do not have access to payroll.</EmptyState>;
  // Staff salaries are company-wide: a user limited to some projects sees labour and contracts.
  const staffOk = projectScope(actor) === null;
  const tabs = [
    ...(staffOk ? [{ value: 'staff' as const, label: 'Monthly staff', href: '/payroll' }] : []),
    { value: 'labour' as const, label: 'Daily-wage labour', href: '/payroll?tab=labour' },
    { value: 'contracts' as const, label: 'Contractors', href: '/payroll?tab=contracts' },
  ];
  const sp = await searchParams;
  const tab: Tab = tabs.find((t) => t.value === sp.tab)?.value ?? tabs[0]?.value ?? 'labour';
  // BUG-149: last month's salaries are usually paid early in this month; offer the last 3 months.
  const current = todayIn().slice(0, 7);
  const [y, m] = current.split('-').map(Number) as [number, number];
  const periods = [0, 1, 2].map((n) =>
    new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7),
  );
  const period = periods.find((p) => p === sp.period) ?? current;
  const rights = {
    edit: can(actor, 'payroll', 'edit'),
    full: can(actor, 'payroll', 'full'),
    owner: actor.role === 'owner',
    me: actor.userId,
    lockDate: company.lockDate,
  };
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`Payroll · ${MONTH.format(new Date(`${period}-01T00:00:00Z`))}`}
        subtitle="Salaries, daily wages and contractor payments. Anything entered by someone else waits for the owner."
      />
      <LinkTabs value={tab} items={tabs} />
      {await body(tab, actor, period, periods, rights)}
    </div>
  );
}

async function body(
  tab: Tab,
  actor: Awaited<ReturnType<typeof getSession>>['actor'],
  period: string,
  periods: string[],
  rights: PayrollRights,
) {
  const s = services();
  if (tab === 'staff') {
    const [staff, preview, runs, advances] = await Promise.all([
      s.payroll.employees(actor, 'salaried'),
      s.payroll.preview(actor, period),
      s.payroll.runs(actor),
      s.payroll.advances(actor),
    ]);
    return (
      <StaffView
        staff={staff}
        preview={preview}
        runs={runs}
        advances={advances}
        period={period}
        periods={periods}
        rights={rights}
      />
    );
  }
  const projects = await projectOptions(actor, 'spend');
  if (tab === 'labour') {
    const [workers, payments] = await Promise.all([
      s.labour.workers(actor),
      s.labour.payments(actor, 'wage'),
    ]);
    return <LabourView workers={workers} payments={payments} projects={projects} rights={rights} />;
  }
  const [jobs, payments] = await Promise.all([
    s.labour.jobs(actor),
    s.labour.payments(actor, 'contract'),
  ]);
  return <ContractsView jobs={jobs} payments={payments} projects={projects} rights={rights} />;
}
