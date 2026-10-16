import { can, formatDate, todayIn } from '@csd/core';
import { withTenant } from '@csd/db';
import { EmptyState } from '@/components/ui';
import { requireActor } from '@/lib/session';
import { services } from '@/lib/server';

export default async function DashboardPage() {
  const actor = await requireActor();
  const { name } = await withTenant(services().pool, actor, async (c) => {
    const { rows } = await c.query<{ name: string }>('SELECT name FROM app_user WHERE id = $1', [
      actor.userId,
    ]);
    return rows[0] ?? { name: '' };
  });
  const hour = Number(
    new Intl.DateTimeFormat('en-IN', {
      hour: 'numeric',
      hour12: false,
      timeZone: 'Asia/Kolkata',
    }).format(new Date()),
  );
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
