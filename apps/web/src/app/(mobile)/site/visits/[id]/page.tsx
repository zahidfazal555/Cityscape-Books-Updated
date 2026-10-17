import Link from 'next/link';
import { can, formatDate } from '@csd/core';
import { EmptyState } from '@/components/ui';
import { COVERAGE_LABEL, SLOT_LABEL } from '@/lib/support';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { CompleteVisit } from './complete-visit';

/** Mobile service visit (FR-23.4): job, Call button, photos, work done, optional cost. */
export default async function VisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await getSession();
  const { id } = await params;
  const v = await services()
    .visits.get(actor, id)
    .catch(() => null);
  if (!v) return <EmptyState>Visit not found.</EmptyState>;
  return (
    <div className="flex flex-col gap-4">
      <Link href="/site" className="flex min-h-[44px] items-center text-[14px] text-primary">
        ← Home
      </Link>
      <section className="rounded-lg border border-line bg-white p-4 text-[14px]">
        <div className="text-xs text-muted">
          {v.ticketNumber} · {formatDate(v.visitDate)} · {SLOT_LABEL[v.slot]}
        </div>
        <h1 className="text-[18px] font-semibold">{v.subject}</h1>
        <div className="mt-1 text-muted">
          {v.projectCode} · {v.projectName} · {v.clientName}
        </div>
        {v.siteAddress ? <div className="mt-1">{v.siteAddress}</div> : null}
        <div className="mt-1 text-xs text-muted">
          {COVERAGE_LABEL[v.coverage as keyof typeof COVERAGE_LABEL] ?? v.coverage}
        </div>
        {v.instructions ? <p className="mt-2 whitespace-pre-wrap">{v.instructions}</p> : null}
        {v.callerPhone ? (
          <a
            href={`tel:${v.callerPhone}`}
            className="mt-3 flex h-12 items-center justify-center rounded-lg border border-primary text-[15px] font-semibold text-primary"
          >
            Call {v.callerName ?? 'client'}
          </a>
        ) : null}
      </section>
      {/* BUG-170: only the visit's engineer or a ticket handler may complete it. */}
      {v.status === 'scheduled' &&
      (v.engineerId === actor.userId || can(actor, 'tickets', 'edit', v.projectId)) ? (
        <CompleteVisit visitId={v.id} />
      ) : (
        <EmptyState>This visit is {v.status}.</EmptyState>
      )}
    </div>
  );
}
