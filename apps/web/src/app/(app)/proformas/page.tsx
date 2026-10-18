import { can } from '@csd/core';
import type { ProformaStatus } from '@csd/services';
import { EmptyState } from '@/components/ui';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { ProformasView } from './proformas-view';

const STATUSES = [
  'draft',
  'sent',
  'partially_paid',
  'paid',
  'overdue',
  'converted',
  'cancelled',
] as const;

export default async function ProformasPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { actor } = await getSession();
  if (!can(actor, 'proformas', 'view'))
    return <EmptyState>You do not have access to proforma invoices.</EmptyState>;
  const raw = (await searchParams).status;
  const status = STATUSES.find((s) => s === raw) as ProformaStatus | undefined;
  const canEdit = can(actor, 'proformas', 'edit');
  const [proformas, all, projects, letterhead] = await Promise.all([
    services().proformas.list(actor, { status }),
    status ? services().proformas.list(actor) : Promise.resolve(null),
    canEdit && can(actor, 'projects', 'view')
      ? services().projects.list(actor, 'active')
      : Promise.resolve([]),
    services().settings.letterhead(actor),
  ]);
  return (
    <ProformasView
      proformas={proformas}
      all={all ?? proformas}
      filter={status ?? 'all'}
      canEdit={canEdit}
      companyStateCode={letterhead.stateCode}
      projects={projects.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        clientName: p.clientName,
        clientStateCode: p.clientStateCode,
      }))}
    />
  );
}
