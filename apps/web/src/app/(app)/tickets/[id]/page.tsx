import Link from 'next/link';
import { can } from '@csd/core';
import { EmptyState } from '@/components/ui';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { TicketDetailView } from './ticket-detail';

/** README §18 ticket detail: thread and composer, with properties, SLA, site, visits, billing, rating. */
export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await getSession();
  if (!can(actor, 'tickets', 'view'))
    return <EmptyState>You do not have access to support tickets.</EmptyState>;
  const { id } = await params;
  const s = services();
  const ticket = await s.tickets.get(actor, id).catch(() => null);
  if (!ticket) return <EmptyState>Ticket not found.</EmptyState>;
  const edit = can(actor, 'tickets', 'edit', ticket.projectId);
  const kb = can(actor, 'kb', 'view');
  const [visits, billing, handlers, engineers, templates, guides, quotes, invoices] =
    await Promise.all([
      s.visits.list(actor, id),
      s.ticketBilling.get(actor, id),
      s.tickets.handlers(actor),
      edit ? s.tickets.engineers(actor) : Promise.resolve([]),
      kb ? s.kb.templates(actor) : Promise.resolve([]),
      kb ? s.kb.articles(actor) : Promise.resolve([]),
      // BUG-170: only someone who can link documents needs the candidates.
      edit && can(actor, 'quotes', 'edit') ? s.quotations.list(actor) : Promise.resolve([]),
      edit && can(actor, 'invoices', 'edit', ticket.projectId)
        ? s.invoices.list(actor, { projectId: ticket.projectId })
        : Promise.resolve([]),
    ]);
  // Documents that can still be linked: the client's quotations, the project's invoices.
  const linked = new Set(billing.documents.map((d) => d.id));
  const candidates = [
    ...quotes
      .filter(
        (q) => q.clientId === ticket.clientId && (!q.projectId || q.projectId === ticket.projectId),
      )
      .map((q) => ({ kind: 'quotation' as const, id: q.id, label: `${q.number} · ${q.title}` })),
    ...invoices.map((i) => ({ kind: 'invoice' as const, id: i.id, label: i.number })),
  ].filter((d) => !linked.has(d.id));
  return (
    <div className="flex flex-col gap-3">
      <Link href="/tickets" className="text-[13px] text-primary">
        ← Support
      </Link>
      <TicketDetailView
        ticket={ticket}
        visits={visits}
        billing={billing}
        handlers={handlers}
        engineers={engineers}
        templates={templates}
        guides={guides}
        candidates={candidates}
        now={new Date().toISOString()}
        rights={{
          edit,
          quotes: can(actor, 'quotes', 'edit'),
          invoices: can(actor, 'invoices', 'edit', ticket.projectId),
        }}
      />
    </div>
  );
}
