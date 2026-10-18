'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { todayIn } from '@csd/core';
import type { ProformaDetail } from '@csd/services';
import { DownloadLink } from '@/components/accounts/tabs';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Drawer } from '@/components/kit';
import { ReceiptDrawer } from '@/components/sales/receipt-drawer';
import { useAction } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import { rupees } from '@/lib/format';
import { ProformaDrawer } from '../proforma-drawer';

type Open = 'edit' | 'advance' | 'convert' | null;

export function ProformaActions({
  proforma: pf,
  rights,
  companyStateCode,
}: {
  proforma: ProformaDetail;
  rights: { edit: boolean; full: boolean; receive: boolean; convert: boolean };
  companyStateCode: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Open>(null);
  const { busy, error, run } = useAction();
  const live = pf.status !== 'converted' && pf.status !== 'cancelled';
  const noAdvances = pf.advances === 0;
  const done = () => {
    setOpen(null);
    router.refresh();
  };
  const cancel = () => {
    if (!window.confirm(`Cancel ${pf.number}? The number stays used; proformas are never deleted.`))
      return;
    void run(() => apiFetch(`/api/v1/proformas/${pf.id}/cancel`, { method: 'POST' }));
  };
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <DownloadLink href={`/api/v1/proformas/${pf.id}/pdf`}>Download PDF</DownloadLink>
        <Button variant="ghost" onClick={() => window.print()}>
          Print
        </Button>
        {live && noAdvances && rights.full ? (
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
        {live && noAdvances && rights.edit ? (
          <Button variant="ghost" onClick={() => setOpen('edit')}>
            Edit
          </Button>
        ) : null}
        {pf.status === 'draft' && rights.edit ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              run(() => apiFetch(`/api/v1/proformas/${pf.id}/send`, { method: 'POST' }))
            }
          >
            Mark as sent
          </Button>
        ) : null}
        {live && pf.balance > 0 && rights.receive ? (
          <Button variant="ghost" onClick={() => setOpen('advance')}>
            Record advance
          </Button>
        ) : null}
        {live && rights.convert ? (
          <Button onClick={() => setOpen('convert')}>Convert to tax invoice</Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      {open === 'edit' ? (
        <ProformaDrawer
          proforma={pf}
          projects={[]}
          companyStateCode={companyStateCode}
          onClose={() => setOpen(null)}
          onSaved={done}
        />
      ) : null}
      {open === 'advance' ? (
        <ReceiptDrawer
          targets={[
            {
              kind: 'proforma',
              id: pf.id,
              number: pf.number,
              clientName: pf.clientName,
              projectCode: pf.projectCode,
              balance: pf.balance,
            },
          ]}
          onClose={() => setOpen(null)}
          onSaved={done}
        />
      ) : null}
      {open === 'convert' ? (
        <ConvertDrawer
          proforma={pf}
          onClose={() => setOpen(null)}
          onDone={(id) => router.push(`/invoices/${id}`)}
        />
      ) : null}
    </div>
  );
}

/** FR-6.5: the next CSD/ number, dated today by default; advances move onto the invoice. */
function ConvertDrawer({
  proforma: pf,
  onClose,
  onDone,
}: {
  proforma: ProformaDetail;
  onClose: () => void;
  onDone: (invoiceId: string) => void;
}) {
  const [invoiceDate, setInvoiceDate] = useState(todayIn());
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  return (
    <Drawer
      title={`Convert ${pf.number} to a tax invoice`}
      width={480}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  apiFetch<{ invoiceId: string }>(`/api/v1/proformas/${pf.id}/convert`, {
                    method: 'POST',
                    idempotencyKey,
                    body: { invoiceDate },
                  }),
                (r) => onDone((r as { invoiceId: string }).invoiceId),
              )
            }
          >
            {busy ? 'Issuing…' : 'Issue tax invoice'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">
          A GST tax invoice with the same lines ({rupees(pf.total)}) is issued.{' '}
          {pf.advances > 0
            ? `The ${rupees(pf.advances)} received in advance is shown as already paid on it.`
            : 'No advance has been received.'}
        </p>
        <Field label="Invoice date" htmlFor="cv-date">
          <Input
            id="cv-date"
            type="date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
          />
        </Field>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
