import { can, formatDate, todayIn } from '@csd/core';
import { redirect } from 'next/navigation';
import {
  Alerts,
  Kpis,
  ProjectsTable,
  ReceivablesAgeing,
  SpendByCategory,
  SpendByProject,
} from '@/components/dashboard/dashboard-view';
import { EmptyState } from '@/components/ui';
import { istHour } from '@/lib/format';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';

/** README §2: greeting, alerts, KPI cards, projects, spend by category and receivables ageing. */
export default async function DashboardPage() {
  const { actor, name } = await getSession();
  // README §17: the site engineer works from the mobile layout.
  if (actor.role === 'site') redirect('/site');
  const hour = istHour();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const d = can(actor, 'dashboard', 'view') ? await services().dashboard.summary(actor) : null;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[22px] font-semibold">
          {greeting}, {name.split(' ')[0]}
        </h1>
        <p className="text-[13px] text-muted">{formatDate(todayIn())}</p>
      </div>
      {d === null ? (
        <EmptyState>Your role has no dashboard. Use the menu to open your work.</EmptyState>
      ) : (
        <>
          <Alerts alerts={d.alerts} />
          <Kpis kpis={d.kpis} />
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
            <SpendByCategory spend={d.spendByCategory} />
            <SpendByProject projects={d.projects} />
            <ReceivablesAgeing ageing={d.ageing} />
          </div>
          <section>
            <h2 className="mb-2 text-[15px] font-semibold">Active projects</h2>
            <ProjectsTable projects={d.projects} />
          </section>
        </>
      )}
    </div>
  );
}
