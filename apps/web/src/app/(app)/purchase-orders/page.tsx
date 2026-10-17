import { can } from '@csd/core';
import type { PoStatus } from '@csd/services';
import { EmptyState } from '@/components/ui';
import { projectOptions, vendorOptions } from '@/lib/purchase-options';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { PosView } from './pos-view';

const STATUSES = ['draft', 'issued', 'partly_billed', 'billed', 'cancelled'] as const;

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { actor, company } = await getSession();
  if (!can(actor, 'pos', 'view'))
    return <EmptyState>You do not have access to purchase orders.</EmptyState>;
  const raw = (await searchParams).status;
  const status = STATUSES.find((s) => s === raw) as PoStatus | undefined;
  const canEdit = can(actor, 'pos', 'edit');
  const [pos, all, vendors, projects] = await Promise.all([
    services().purchaseOrders.list(actor, { status }),
    status ? services().purchaseOrders.list(actor) : Promise.resolve(null),
    canEdit ? vendorOptions(actor) : Promise.resolve([]),
    canEdit ? projectOptions(actor) : Promise.resolve([]),
    services()
      .settings.letterhead(actor)
      .catch(() => null),
  ]);
  return (
    <PosView
      pos={pos}
      all={all ?? pos}
      filter={status ?? 'all'}
      canEdit={canEdit}
      vendors={vendors}
      projects={projects}
      companyStateCode={company.stateCode}
    />
  );
}
