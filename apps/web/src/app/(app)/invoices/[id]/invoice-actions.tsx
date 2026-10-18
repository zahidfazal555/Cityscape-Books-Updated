'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { todayIn } from '@csd/core';
import type { InvoiceDetail } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Drawer } from '@/components/kit';
import { ReceiptDrawer } from '@/components/sales/receipt-drawer';
import { useAction } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import { InvoiceDrawer } from '../invoice-drawer';

export function InvoiceActions({
  invoice,
  canReceive,
  canCancel,
  canEdit,
  companyStateCode,
}: {
  invoice: InvoiceDetail;
  canReceive: boolean;
  canCancel: boolean;
  canEdit: boolean;
  companyStateCode: string;
}) {
  const [open, setOpen] = useState<'receipt' | 'cancel' | 'edit' | null>(null);
  const router = useRouter();
  const live = invoice.status !== 'cancelled';
  const done = () => {
    setOpen(null);
    router.refresh();
  };
  return (
    <div className="flex gap-2">
      <Button variant="ghost" onClick={() => window.print()}>
        Print / PDF
      </Button>
      {canCancel && invoice.cancellable ? (
        <Button variant="ghost" onClick={() => setOpen('cancel')}>
          Cancel invoice
        </Button>
      ) : null}
      {canEdit && invoice.editable ? (
        <Button variant="ghost" onClick={() => setOpen('edit')}>
          Edit
        </Button>
      ) : null}
      {live && canReceive && invoice.balance > 0 ? (
        <Button onClick={() => setOpen('receipt')}>Record receipt</Button>
      ) : null}
      {open === 'receipt' ? (
        <ReceiptDrawer
          targets={[
            {
              kind: 'invoice',
              id: invoice.id,
              number: invoice.number,
              clientName: invoice.clientName,
              projectCode: invoice.projectCode,
              balance: invoice.balance,
            },
          ]}
          onClose={() => setOpen(null)}
          onSaved={done}
        />
      ) : null}
      {open === 'edit' ? (
        <InvoiceDrawer
          invoice={invoice}
          projects={[]}
          companyStateCode={companyStateCode}
          onClose={() => setOpen(null)}
          onSaved={done}
        />
      ) : null}
      {open === 'cancel' ? (
        <CancelDrawer invoice={invoice} onClose={() => setOpen(null)} onDone={done} />
      ) : null}
    </div>
  );
}

/** Cancel with a credit note CN/FY/#### (invoices = full, no receipts of its own). */
function CancelDrawer({
  invoice,
  onClose,
  onDone,
}: {
  invoice: { id: string; number: string; invoiceDate: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [cnDate, setCnDate] = useState(todayIn());
  const [reason, setReason] = useState('');
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  return (
    <Drawer
      title={`Cancel ${invoice.number}`}
      width={480}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep invoice
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  apiFetch(`/api/v1/invoices/${invoice.id}/cancel`, {
                    method: 'POST',
                    idempotencyKey,
                    body: { cnDate, reason },
                  }),
                onDone,
              )
            }
          >
            {busy ? 'Cancelling…' : 'Issue credit note'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">
          A credit note reverses the invoice in full. Advances applied from a proforma go back to
          the proforma as customer advances. Receipts recorded against this invoice must be deleted
          first.
        </p>
        <Field label="Credit note date" htmlFor="cn-date">
          <Input
            id="cn-date"
            type="date"
            value={cnDate}
            onChange={(e) => setCnDate(e.target.value)}
          />
        </Field>
        <Field label="Reason" htmlFor="cn-reason">
          <Input id="cn-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
