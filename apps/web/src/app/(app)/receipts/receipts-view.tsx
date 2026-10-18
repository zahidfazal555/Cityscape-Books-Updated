'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDate } from '@csd/core';
import type { Paise } from '@csd/core';
import type { Receipt, ReceiptMode } from '@csd/services';
import { Button, EmptyState, FormError } from '@/components/ui';
import { PageHeader, Row, Table } from '@/components/kit';
import { ReceiptDrawer, type ReceiptTarget } from '@/components/sales/receipt-drawer';
import { useAction } from '@/components/sales/use-action';
import { apiFetch } from '@/lib/client';
import { rupees } from '@/lib/format';
import { MODE_LABEL, RECEIPT_MODES } from '@/lib/sales';

export function ReceiptsView({
  receipts,
  totals,
  lockDate,
  targets,
  canEdit,
  canDelete,
}: {
  receipts: Receipt[];
  totals: Record<ReceiptMode, Paise>;
  lockDate: string | null;
  targets: ReceiptTarget[];
  canEdit: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const { error, run } = useAction();
  const remove = (r: Receipt) => {
    if (
      !window.confirm(
        `Delete ${r.number}? Its journal is reversed; the record stays in the audit trail.`,
      )
    )
      return;
    void run(() => apiFetch(`/api/v1/receipts/${r.id}`, { method: 'DELETE' }));
  };
  return (
    <>
      <PageHeader
        title="Client receipts"
        subtitle="Payments against tax invoices, and advances against proformas."
        action={canEdit ? <Button onClick={() => setAdding(true)}>+ Record receipt</Button> : null}
      />
      <dl className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
        {RECEIPT_MODES.map((m) => (
          <div key={m} className="bg-white p-3">
            <dt className="text-xs text-muted">{MODE_LABEL[m]}</dt>
            <dd className="num text-[18px] font-semibold">{rupees(totals[m])}</dd>
          </div>
        ))}
      </dl>
      <FormError message={error} />
      {receipts.length === 0 ? (
        <EmptyState>No receipts yet.</EmptyState>
      ) : (
        <Table
          columns={`1.1fr 0.8fr 1.8fr 1.3fr 0.8fr 1fr 0.9fr 1fr${canDelete ? ' 64px' : ''}`}
          minWidth={1020}
        >
          <Row head>
            <span>Receipt</span>
            <span>Date</span>
            <span>Client · project</span>
            <span>Against</span>
            <span>Mode</span>
            <span>Reference</span>
            <span>Received by</span>
            <span className="text-right">Amount</span>
            {canDelete ? <span /> : null}
          </Row>
          {receipts.map((r) => (
            <Row key={r.id}>
              <span className="font-mono text-[12px]">{r.number}</span>
              <span className="text-muted">{formatDate(r.receiptDate)}</span>
              <span className="min-w-0">
                <span className="block truncate">{r.clientName}</span>
                <span className="block text-xs text-muted">{r.projectCode}</span>
              </span>
              <span className="min-w-0 truncate font-mono text-[12px]">
                {r.invoiceNumber ?? '—'}
                {r.proformaNumber ? (
                  <span className="block text-[11px] text-muted">advance · {r.proformaNumber}</span>
                ) : null}
              </span>
              <span>{MODE_LABEL[r.mode]}</span>
              <span className="truncate text-muted">{r.reference ?? '—'}</span>
              <span className="truncate text-muted">{r.receivedBy ?? '—'}</span>
              <span className="num text-right">{rupees(r.amount)}</span>
              {canDelete && deletable(r, lockDate) ? (
                <button
                  type="button"
                  onClick={() => remove(r)}
                  className="text-[12.5px] text-danger hover:underline"
                >
                  Delete
                </button>
              ) : canDelete ? (
                <span />
              ) : null}
            </Row>
          ))}
        </Table>
      )}
      {adding ? (
        <ReceiptDrawer
          targets={targets}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

/** Applied advances and receipts in a locked period are refused by the server: no button. */
function deletable(r: Receipt, lockDate: string | null): boolean {
  return !r.applied && (lockDate === null || r.receiptDate > lockDate);
}
