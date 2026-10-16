import Link from 'next/link';
import { can, formatDate } from '@csd/core';
import { Pill } from '@/components/kit';
import { A4Document, placeOfSupply } from '@/components/sales/a4-document';
import { rupees } from '@/lib/format';
import { loadOr404 } from '@/lib/not-found';
import { INVOICE_STATUS, MODE_LABEL } from '@/lib/sales';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { InvoiceActions } from './invoice-actions';

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await getSession();
  const { id } = await params;
  const inv = await loadOr404(id, () => services().invoices.get(actor, id));
  const letterhead = await services().settings.letterhead(actor);
  const status = INVOICE_STATUS[inv.status];
  const canDeleteReceipt = can(actor, 'receipts', 'full', inv.projectId);
  return (
    <div className="flex flex-col gap-4">
      <div data-noprint className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href="/invoices" className="text-[13px] text-muted hover:text-primary">
            ← Tax invoices
          </Link>
          <Pill tone={status.tone}>{status.label}</Pill>
          <span className="text-[13px] text-muted">
            Balance due <span className="num font-medium text-ink">{rupees(inv.balance)}</span>
          </span>
        </div>
        <InvoiceActions
          invoice={{
            id: inv.id,
            number: inv.number,
            clientName: inv.clientName,
            projectCode: inv.projectCode,
            balance: inv.balance,
            status: inv.status,
            invoiceDate: inv.invoiceDate,
          }}
          canReceive={can(actor, 'receipts', 'edit', inv.projectId)}
          canCancel={can(actor, 'invoices', 'full', inv.projectId)}
        />
      </div>
      {inv.creditNote ? (
        <p className="rounded-md border border-line bg-track px-3 py-2 text-[13px]">
          Cancelled by credit note <span className="font-mono">{inv.creditNote.number}</span> on{' '}
          {formatDate(inv.creditNote.date)}: {inv.creditNote.reason}
        </p>
      ) : null}
      <A4Document
        title="TAX INVOICE"
        number={inv.number}
        letterhead={letterhead}
        billTo={{ name: inv.clientName, gstin: inv.clientGstin, address: inv.clientAddress }}
        meta={[
          ['Invoice date', formatDate(inv.invoiceDate)],
          ['Due date', formatDate(inv.dueDate)],
          ['Place of supply', placeOfSupply(inv.placeOfSupply)],
          ['Project', `${inv.projectCode} · ${inv.projectName}`],
        ]}
        lines={inv.lines}
        totals={inv}
        interState={inv.interState}
        footer={
          <div className="flex flex-col gap-1">
            <div className="text-[11px] font-semibold uppercase tracking-[.05em] text-muted">
              Payments received
            </div>
            {inv.receipts.length === 0 ? (
              <p className="text-muted">None yet.</p>
            ) : (
              inv.receipts.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3">
                  <span>
                    <span className="font-mono text-[12px]">{r.number}</span> · {formatDate(r.date)}{' '}
                    · {MODE_LABEL[r.mode as keyof typeof MODE_LABEL] ?? r.mode}
                    {r.reference ? ` · ${r.reference}` : ''}
                  </span>
                  <span className="num">{rupees(r.amount)}</span>
                </div>
              ))
            )}
            {inv.notes ? <p className="mt-2 whitespace-pre-line text-muted">{inv.notes}</p> : null}
            {canDeleteReceipt && inv.receipts.length > 0 ? (
              <p data-noprint className="mt-1 text-xs text-subtle">
                To delete a receipt, open Client receipts.
              </p>
            ) : null}
          </div>
        }
      />
    </div>
  );
}
