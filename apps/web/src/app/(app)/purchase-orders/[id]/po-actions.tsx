'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PoDetail } from '@csd/services';
import { DownloadLink } from '@/components/accounts/tabs';
import { Button } from '@/components/ui';
import { BillDrawer } from '@/components/purchases/bill-drawer';
import { useAction } from '@/components/sales/use-action';
import { apiFetch } from '@/lib/client';
import { PoDrawer } from '../po-drawer';

/** Actions by status (FR-9.3, FR-9.4). The server re-checks every one. */
export function PoActions({
  po,
  rights,
  companyStateCode,
}: {
  po: PoDetail;
  rights: { edit: boolean; full: boolean; bill: boolean };
  companyStateCode: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<'edit' | 'bill' | null>(null);
  const { busy, error, run } = useAction();
  const post = (action: string) => () =>
    run(() => apiFetch(`/api/v1/purchase-orders/${po.id}/${action}`, { method: 'POST' }));
  const remove = () => {
    if (!window.confirm(`Delete draft ${po.number}?`)) return;
    void run(
      () => apiFetch(`/api/v1/purchase-orders/${po.id}`, { method: 'DELETE' }),
      () => router.push('/purchase-orders'),
    );
  };
  const cancel = () => {
    if (!window.confirm(`Cancel ${po.number}?`)) return;
    void post('cancel')();
  };
  const done = () => {
    setOpen(null);
    router.refresh();
  };
  const billable = (po.status === 'issued' || po.status === 'partly_billed') && rights.bill;
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <DownloadLink href={`/api/v1/purchase-orders/${po.id}/pdf`}>Download PDF</DownloadLink>
        <Button variant="ghost" onClick={() => window.print()}>
          Print
        </Button>
        {po.status === 'draft' && rights.full ? (
          <Button variant="ghost" onClick={remove} disabled={busy}>
            Delete
          </Button>
        ) : null}
        {po.status !== 'cancelled' &&
        po.bills.length === 0 &&
        po.status !== 'draft' &&
        rights.full ? (
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            Cancel PO
          </Button>
        ) : null}
        {po.status === 'draft' && rights.edit ? (
          <Button variant="ghost" onClick={() => setOpen('edit')}>
            Edit
          </Button>
        ) : null}
        {po.status === 'draft' && rights.edit ? (
          <Button onClick={post('issue')} disabled={busy}>
            Issue PO
          </Button>
        ) : null}
        {billable ? <Button onClick={() => setOpen('bill')}>Convert to bill</Button> : null}
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      {open === 'edit' ? (
        <PoDrawer
          po={po}
          vendors={[]}
          projects={[]}
          companyStateCode={companyStateCode}
          onClose={() => setOpen(null)}
          onSaved={done}
        />
      ) : null}
      {open === 'bill' ? (
        <BillDrawer
          prefill={{
            vendorId: po.vendorId,
            projectId: po.projectId,
            gstRate: po.gstRate,
            taxable: po.unbilled,
            purchaseOrderId: po.id,
            purchaseOrderNumber: po.number,
          }}
          vendors={[
            {
              id: po.vendorId,
              name: po.vendorName,
              gstin: po.vendorGstin,
              stateCode: po.vendorGstin?.slice(0, 2) ?? companyStateCode,
            },
          ]}
          projects={[]}
          companyStateCode={companyStateCode}
          onClose={() => setOpen(null)}
          onSaved={() => router.push('/bills')}
        />
      ) : null}
    </div>
  );
}
