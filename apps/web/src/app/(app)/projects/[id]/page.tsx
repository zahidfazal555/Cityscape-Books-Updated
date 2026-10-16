import { notFound } from 'next/navigation';
import { DomainError, can, formatDate, isUuid } from '@csd/core';
import { Pill } from '@/components/kit';
import { EmptyState } from '@/components/ui';
import { STATUS_LABEL, STATUS_TONE, rupees } from '@/lib/format';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { ProjectActions } from './project-actions';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await getSession();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const project = await services()
    .projects.get(actor, id)
    .catch((e: unknown) => {
      if (e instanceof DomainError && (e.status === 404 || e.status === 403)) notFound();
      throw e;
    });
  const canEdit = can(actor, 'projects', 'edit', id);
  const [clients, team] = canEdit
    ? await Promise.all([
        can(actor, 'contacts', 'view')
          ? services().contacts.list(actor, 'client')
          : Promise.resolve([]),
        services().users.team(actor),
      ])
    : [[], []];
  const name = (uid: string | null) => team.find((m) => m.id === uid)?.name ?? '—';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded bg-track px-2 py-0.5 font-mono text-[11.5px] text-muted">
              {project.code}
            </span>
            <Pill tone={STATUS_TONE[project.status]}>{STATUS_LABEL[project.status]}</Pill>
          </div>
          <h1 className="text-[22px] font-semibold">{project.name}</h1>
          <p className="text-[13px] text-muted">
            {project.clientName} · {project.siteAddress ?? 'No site address'} · started{' '}
            {formatDate(project.startDate)}
            {canEdit
              ? ` · manager ${name(project.managerId)} · engineer ${name(project.engineerId)}`
              : ''}
          </p>
        </div>
        {canEdit ? (
          <ProjectActions
            project={project}
            canReopen={can(actor, 'projects', 'full', id)}
            clients={clients.map((c) => ({ id: c.id, name: c.name, stateCode: c.stateCode }))}
            team={team}
          />
        ) : null}
      </div>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
        {[
          ['Contract (excl. GST)', rupees(project.contractValue)],
          ['Cost budget', rupees(project.costBudget)],
          ['Start', formatDate(project.startDate)],
          ['End', project.endDate ? formatDate(project.endDate) : '—'],
        ].map(([k, v]) => (
          <div key={k} className="bg-white p-3">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="num text-[18px] font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <EmptyState>
        The ledger, spend by category, invoices, bills and profit &amp; loss tabs arrive with Sales
        and Purchases.
      </EmptyState>
    </div>
  );
}
