import { can } from '@csd/core';
import { TICKET_VIEWS, type TicketView } from '@csd/services';
import { PageHeader } from '@/components/kit';
import { LinkTabs } from '@/components/accounts/tabs';
import { EmptyState } from '@/components/ui';
import { projectOptions } from '@/lib/purchase-options';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { SupportDashboardView } from './dashboard-view';
import { TicketQueue } from './ticket-queue';
import { VisitsTable } from './visits-table';

type Tab = 'queue' | 'visits' | 'dashboard';

/** README §18 Support: queue, site visits and dashboard. */
export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; view?: string }>;
}) {
  const { actor } = await getSession();
  if (!can(actor, 'tickets', 'view'))
    return <EmptyState>You do not have access to support tickets.</EmptyState>;
  const sp = await searchParams;
  const tabs: { value: Tab; label: string; href: string }[] = [
    { value: 'queue', label: 'Tickets', href: '/tickets' },
    { value: 'visits', label: 'Site visits', href: '/tickets?tab=visits' },
    { value: 'dashboard', label: 'Dashboard', href: '/tickets?tab=dashboard' },
  ];
  const tab = tabs.find((t) => t.value === sp.tab)?.value ?? 'queue';
  const s = services();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Support"
        subtitle="Every call, walk-in and message from clients, with its SLA."
      />
      <LinkTabs value={tab} items={tabs} />
      {tab === 'visits' ? <VisitsTable visits={await s.visits.list(actor)} /> : null}
      {tab === 'dashboard' ? (
        <SupportDashboardView d={await s.supportDashboard.get(actor)} />
      ) : null}
      {tab === 'queue' ? await queue(actor, sp.view) : null}
    </div>
  );
}

async function queue(actor: Awaited<ReturnType<typeof getSession>>['actor'], raw?: string) {
  const s = services();
  const view: TicketView = TICKET_VIEWS.find((v) => v === raw) ?? 'open';
  const [tickets, counts, projects, handlers, register] = await Promise.all([
    s.tickets.list(actor, view),
    s.tickets.counts(actor),
    projectOptions(actor, 'bill'),
    s.tickets.handlers(actor),
    // For the live coverage check in the Log ticket drawer (FR-19.7).
    can(actor, 'warranty', 'view') ? s.warranty.register(actor) : Promise.resolve([]),
  ]);
  const warranty = Object.fromEntries(
    register.map((w) => [
      w.projectId,
      { handoverDate: w.handoverDate, warrantyMonths: w.warrantyMonths, amcUntil: w.amcUntil },
    ]),
  );
  return (
    <TicketQueue
      tickets={tickets}
      counts={counts}
      view={view}
      projects={projects}
      handlers={handlers}
      warranty={warranty}
      canLog={can(actor, 'tickets', 'edit')}
      now={new Date().toISOString()}
    />
  );
}
