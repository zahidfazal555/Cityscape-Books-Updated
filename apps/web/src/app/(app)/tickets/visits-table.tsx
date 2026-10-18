import Link from 'next/link';
import { formatDate } from '@csd/core';
import type { SiteVisit } from '@csd/services';
import { Pill, Row, Table } from '@/components/kit';
import { EmptyState } from '@/components/ui';
import { rupees } from '@/lib/format';
import { SLOT_LABEL } from '@/lib/support';

const VISIT_TONE = { scheduled: 'blue', completed: 'green', cancelled: 'grey' } as const;
export const VISIT_LABEL = {
  scheduled: 'Scheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
} as const;

export function VisitPill({ status }: { status: SiteVisit['status'] }) {
  return <Pill tone={VISIT_TONE[status]}>{VISIT_LABEL[status]}</Pill>;
}

/** Support → Site visits: every visit, scheduled first. */
export function VisitsTable({ visits }: { visits: SiteVisit[] }) {
  if (visits.length === 0) return <EmptyState>No site visits yet.</EmptyState>;
  return (
    <Table columns="0.9fr 1.1fr 0.8fr 2fr 1.1fr 0.9fr 0.8fr" minWidth={1000}>
      <Row head>
        <span>Date</span>
        <span>Slot</span>
        <span>Ticket</span>
        <span>Job · project</span>
        <span>Engineer</span>
        <span>Status</span>
        <span className="text-right">Cost</span>
      </Row>
      {visits.map((v) => (
        <Row key={v.id}>
          <span>{formatDate(v.visitDate)}</span>
          <span className="text-muted">{SLOT_LABEL[v.slot]}</span>
          <Link href={`/tickets/${v.ticketId}`} className="font-mono text-[12px] text-primary">
            {v.ticketNumber}
          </Link>
          <span className="min-w-0">
            <span className="block truncate">{v.subject}</span>
            <span className="block truncate text-xs text-muted">
              {v.projectCode} · {v.clientName}
            </span>
          </span>
          <span className="truncate">{v.engineerName}</span>
          <span>
            <VisitPill status={v.status} />
          </span>
          <span className="num text-right">{v.cost ? rupees(v.cost) : '—'}</span>
        </Row>
      ))}
    </Table>
  );
}
