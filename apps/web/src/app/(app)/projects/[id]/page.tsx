import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DomainError, can, formatDate, isUuid } from '@csd/core';
import { Pill } from '@/components/kit';
import { ProjectCharts } from '@/components/dashboard/project-charts';
import { STATUS_LABEL, STATUS_TONE, rupees } from '@/lib/format';
import { INVOICE_STATUS, PROFORMA_STATUS } from '@/lib/sales';
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
  const [invoices, proformas] = await Promise.all([
    can(actor, 'invoices', 'view', id)
      ? services().invoices.list(actor, { projectId: id })
      : Promise.resolve([]),
    can(actor, 'proformas', 'view', id)
      ? services().proformas.list(actor, { projectId: id })
      : Promise.resolve([]),
  ]);
  // Same audience as the dashboard (site engineers have none); the service checks it again.
  const charts = can(actor, 'dashboard', 'view')
    ? await services().dashboard.project(actor, id)
    : null;
  const held = proformas
    .filter((p) => p.status !== 'converted' && p.status !== 'cancelled')
    .reduce((s, p) => s + p.advances, 0);

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
      {held > 0 ? (
        <p className="rounded-md border border-line bg-primary-tint px-3 py-2 text-[13px] text-primary">
          <span className="num font-semibold">{rupees(held)}</span> held as customer advance
        </p>
      ) : null}
      {invoices.length > 0 || proformas.length > 0 ? (
        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-line bg-white p-4 text-[13px]">
            <h2 className="mb-2 font-semibold">Tax invoices</h2>
            {invoices.length === 0 ? <p className="text-muted">None yet.</p> : null}
            {invoices.map((i) => (
              <p key={i.id} className="flex justify-between gap-3">
                <Link href={`/invoices/${i.id}`} className="font-mono text-primary">
                  {i.number}
                </Link>
                <span className="text-muted">{INVOICE_STATUS[i.status].label}</span>
                <span className="num">{rupees(i.total)}</span>
              </p>
            ))}
          </div>
          <div className="rounded-lg border border-line bg-white p-4 text-[13px]">
            <h2 className="mb-2 font-semibold">Proforma invoices</h2>
            {proformas.length === 0 ? <p className="text-muted">None yet.</p> : null}
            {proformas.map((p) => (
              <p key={p.id} className="flex justify-between gap-3">
                <Link href={`/proformas/${p.id}`} className="font-mono text-primary">
                  {p.number}
                </Link>
                <span className="text-muted">{PROFORMA_STATUS[p.status].label}</span>
                <span className="num">{rupees(p.total)}</span>
              </p>
            ))}
          </div>
        </section>
      ) : null}
      {charts ? <ProjectCharts projectId={id} d={charts} /> : null}
    </div>
  );
}
