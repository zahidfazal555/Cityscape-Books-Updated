import Link from 'next/link';
import { can, formatDate } from '@csd/core';
import { Pill } from '@/components/kit';
import { A4Document, placeOfSupply } from '@/components/sales/a4-document';
import { rupees } from '@/lib/format';
import { loadOr404 } from '@/lib/not-found';
import { MODE_LABEL, PROFORMA_STATUS } from '@/lib/sales';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { ProformaActions } from './proforma-actions';

export default async function ProformaPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await getSession();
  const { id } = await params;
  const pf = await loadOr404(id, () => services().proformas.get(actor, id));
  const letterhead = await services().settings.letterhead(actor);
  const status = PROFORMA_STATUS[pf.status];
  return (
    <div className="flex flex-col gap-4">
      <div data-noprint className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href="/proformas" className="text-[13px] text-muted hover:text-primary">
            ← Proforma invoices
          </Link>
          <Pill tone={status.tone}>{status.label}</Pill>
          <span className="text-[13px] text-muted">
            Advances <span className="num font-medium text-ink">{rupees(pf.advances)}</span> ·
            balance <span className="num font-medium text-ink">{rupees(pf.balance)}</span>
          </span>
        </div>
        <ProformaActions
          proforma={pf}
          companyStateCode={letterhead.stateCode}
          rights={{
            edit: can(actor, 'proformas', 'edit', pf.projectId),
            full: can(actor, 'proformas', 'full', pf.projectId),
            receive: can(actor, 'receipts', 'edit', pf.projectId),
            convert:
              can(actor, 'proformas', 'edit', pf.projectId) &&
              can(actor, 'invoices', 'edit', pf.projectId),
          }}
        />
      </div>
      {pf.invoiceId ? (
        <p className="rounded-md border border-line bg-success-bg px-3 py-2 text-[13px] text-success">
          Converted to tax invoice{' '}
          {can(actor, 'invoices', 'view', pf.projectId) ? (
            <Link href={`/invoices/${pf.invoiceId}`} className="font-mono underline">
              {pf.invoiceNumber}
            </Link>
          ) : (
            <span className="font-mono">{pf.invoiceNumber}</span>
          )}
          . Its advances were moved onto the invoice.
        </p>
      ) : null}
      <A4Document
        title="PROFORMA INVOICE"
        number={pf.number}
        letterhead={letterhead}
        billTo={{
          name: pf.clientName,
          gstin: pf.clientGstin,
          address: pf.clientAddress,
        }}
        meta={[
          ['Date', formatDate(pf.pfDate)],
          ['Payment due', formatDate(pf.dueDate)],
          ['Stage', pf.stage],
          ['Place of supply', placeOfSupply(pf.placeOfSupply)],
          ['Project', pf.projectCode],
        ]}
        lines={pf.lines.map((l, i) => ({ ...l, amount: pf.totals.lines[i]?.amount ?? 0 }))}
        totals={pf.totals}
        interState={pf.totals.interState}
        footer={
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted">
              This is not a tax invoice. A GST tax invoice is issued when the stage is billed.
            </p>
            <div className="mt-2 text-[11px] font-semibold uppercase tracking-[.05em] text-muted">
              Advances received
            </div>
            {pf.advanceReceipts.length === 0 ? (
              <p className="text-muted">None yet.</p>
            ) : (
              pf.advanceReceipts.map((r) => (
                <div key={r.id} className="flex justify-between gap-3">
                  <span>
                    <span className="font-mono text-[12px]">{r.number}</span> · {formatDate(r.date)}{' '}
                    · {MODE_LABEL[r.mode as keyof typeof MODE_LABEL] ?? r.mode}
                    {r.applied ? ' · applied to invoice' : ''}
                  </span>
                  <span className="num">{rupees(r.amount)}</span>
                </div>
              ))
            )}
          </div>
        }
      />
    </div>
  );
}
