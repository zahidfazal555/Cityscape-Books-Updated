import { can } from '@csd/core';
import type { ReceiptTarget } from '@/components/sales/receipt-drawer';
import { EmptyState } from '@/components/ui';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { ReceiptsView } from './receipts-view';

export default async function ReceiptsPage() {
  const { actor } = await getSession();
  if (!can(actor, 'receipts', 'view'))
    return <EmptyState>You do not have access to client receipts.</EmptyState>;
  const canEdit = can(actor, 'receipts', 'edit');
  const { company } = await getSession();
  const [receipts, totals, invoices, proformas] = await Promise.all([
    services().receipts.list(actor),
    services().receipts.totalsByMode(actor),
    canEdit && can(actor, 'invoices', 'view')
      ? services().invoices.list(actor, { open: true })
      : Promise.resolve([]),
    canEdit && can(actor, 'proformas', 'view')
      ? services().proformas.list(actor, { open: true })
      : Promise.resolve([]),
  ]);
  // The picker lists open tax invoices and open proformas (README §4c).
  const targets: ReceiptTarget[] = [
    ...invoices.map((i) => ({ kind: 'invoice' as const, ...pickTarget(i) })),
    ...proformas.map((p) => ({ kind: 'proforma' as const, ...pickTarget(p) })),
  ];
  return (
    <ReceiptsView
      receipts={receipts}
      totals={totals}
      lockDate={company.lockDate}
      targets={targets}
      canEdit={canEdit}
      canDelete={can(actor, 'receipts', 'full')}
    />
  );
}

function pickTarget(d: {
  id: string;
  number: string;
  clientName: string;
  projectCode: string;
  balance: number;
}) {
  return {
    id: d.id,
    number: d.number,
    clientName: d.clientName,
    projectCode: d.projectCode,
    balance: d.balance,
  };
}
