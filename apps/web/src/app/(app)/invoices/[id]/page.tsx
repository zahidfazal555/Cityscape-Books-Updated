import Link from 'next/link';
import { can, formatDate } from '@csd/core';
import { Pill } from '@/components/kit';
import { A4Document } from '@/components/sales/a4-document';
import { invoiceSpec } from '@/lib/documents';
import { rupees } from '@/lib/format';
import { loadOr404 } from '@/lib/not-found';
import { INVOICE_STATUS } from '@/lib/sales';
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
          invoice={inv}
          canReceive={can(actor, 'receipts', 'edit', inv.projectId)}
          canCancel={can(actor, 'invoices', 'full', inv.projectId)}
          canEdit={can(actor, 'invoices', 'edit', inv.projectId)}
          companyStateCode={letterhead.stateCode}
        />
      </div>
      {inv.creditNote ? (
        <p className="rounded-md border border-line bg-track px-3 py-2 text-[13px]">
          Cancelled by credit note <span className="font-mono">{inv.creditNote.number}</span> on{' '}
          {formatDate(inv.creditNote.date)}: {inv.creditNote.reason}
        </p>
      ) : null}
      <A4Document
        spec={invoiceSpec(inv)}
        letterhead={letterhead}
        extra={
          canDeleteReceipt && inv.receipts.length > 0 ? (
            <p data-noprint className="text-xs text-subtle">
              To delete a receipt, open Client receipts.
            </p>
          ) : null
        }
      />
    </div>
  );
}
