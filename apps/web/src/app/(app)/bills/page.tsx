import { can, type Actor } from '@csd/core';
import type { BillStatus } from '@csd/services';
import { EmptyState } from '@/components/ui';
import { projectOptions, vendorOptions } from '@/lib/purchase-options';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { BillsView } from './bills-view';

const STATUSES = ['unpaid', 'partially_paid', 'paid', 'overdue'] as const;

export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { actor, company } = await getSession();
  if (!can(actor, 'bills', 'view'))
    return <EmptyState>You do not have access to purchase bills.</EmptyState>;
  const raw = (await searchParams).status;
  const status = STATUSES.find((s) => s === raw) as BillStatus | undefined;
  const canEdit = can(actor, 'bills', 'edit');
  const [bills, vendors, projects] = await Promise.all([
    services().bills.list(actor, { status }),
    canEdit ? vendorOptions(actor) : Promise.resolve([]),
    canEdit ? projectOptions(actor, 'bill') : Promise.resolve([]),
    services()
      .settings.letterhead(actor)
      .catch(() => null),
  ]);
  return (
    <BillsView
      bills={bills}
      filter={status ?? 'all'}
      rights={rightsOf(actor)}
      lockDate={company.lockDate}
      vendors={vendors}
      projects={projects}
      companyStateCode={company.stateCode}
    />
  );
}

function rightsOf(actor: Actor) {
  return {
    edit: can(actor, 'bills', 'edit'),
    full: can(actor, 'bills', 'full'),
    owner: actor.role === 'owner',
  };
}
