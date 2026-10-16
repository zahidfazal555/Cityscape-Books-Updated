import { can, formatDate, todayIn } from '@csd/core';
import { EmptyState } from '@/components/ui';
import { istHour } from '@/lib/format';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';

export default async function DashboardPage() {
  const { actor, name } = await getSession();
  const hour = istHour();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const projects = can(actor, 'projects', 'view')
    ? await services().projects.list(actor, 'active')
    : [];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[22px] font-semibold">
          {greeting}, {name.split(' ')[0]}
        </h1>
        <p className="text-[13px] text-muted">{formatDate(todayIn())}</p>
      </div>
      {!can(actor, 'dashboard', 'view') ? (
        <EmptyState>Your role has no dashboard. Use the menu to open your work.</EmptyState>
      ) : (
        <section className="rounded-lg border border-line bg-white p-4">
          <h2 className="mb-3 text-[15px] font-semibold">Active projects</h2>
          {projects.length === 0 ? (
            <EmptyState>No active projects yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-divider">
              {projects.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2 text-[13px]">
                  <span>
                    <span className="mr-2 font-mono text-[11.5px] text-muted">{p.code}</span>
                    {p.name}
                  </span>
                  <span className="text-muted">{p.clientName}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-subtle">
            KPIs, budget alerts and ageing arrive with Sales and Accounts.
          </p>
        </section>
      )}
    </div>
  );
}
