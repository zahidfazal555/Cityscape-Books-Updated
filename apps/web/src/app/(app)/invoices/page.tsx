import { can, type InvoiceStatus } from '@csd/core';
import { EmptyState } from '@/components/ui';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { InvoicesView } from './invoices-view';

const STATUSES = ['unpaid', 'partially_paid', 'paid', 'overdue', 'cancelled'] as const;

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { actor } = await getSession();
  if (!can(actor, 'invoices', 'view'))
    return <EmptyState>You do not have access to tax invoices.</EmptyState>;
  const raw = (await searchParams).status;
  const status = STATUSES.find((s) => s === raw) as InvoiceStatus | undefined;
  const canEdit = can(actor, 'invoices', 'edit');
  const [invoices, projects, letterhead] = await Promise.all([
    services().invoices.list(actor, { status }),
    canEdit && can(actor, 'projects', 'view')
      ? services().projects.list(actor, 'active')
      : Promise.resolve([]),
    services().settings.letterhead(actor),
  ]);
  return (
    <InvoicesView
      invoices={invoices}
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
