import Link from 'next/link';
import { can, formatDate } from '@csd/core';
import { Pill } from '@/components/kit';
import { A4Document } from '@/components/sales/a4-document';
import { poSpec } from '@/lib/documents';
import { rupees } from '@/lib/format';
import { loadOr404 } from '@/lib/not-found';
import { PO_STATUS } from '@/lib/purchases';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { PoActions } from './po-actions';

export default async function PoPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, company } = await getSession();
  const { id } = await params;
  const po = await loadOr404(id, () => services().purchaseOrders.get(actor, id));
  const letterhead = await services()
    .settings.letterhead(actor)
    .catch(() => null);
  const status = PO_STATUS[po.status];
  return (
    <div className="flex flex-col gap-4">
      <div data-noprint className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href="/purchase-orders" className="text-[13px] text-muted hover:text-primary">
            ← Purchase orders
          </Link>
          <Pill tone={status.tone}>{status.label}</Pill>
          <span className="text-[13px] text-muted">
            Billed <span className="num font-medium text-ink">{rupees(po.billed)}</span> of{' '}
            {rupees(po.taxable)} · unbilled {rupees(po.unbilled)}
          </span>
        </div>
        <PoActions
          po={po}
          companyStateCode={company.stateCode}
          rights={{
            edit: can(actor, 'pos', 'edit', po.projectId),
            full: can(actor, 'pos', 'full', po.projectId),
            bill: can(actor, 'bills', 'edit', po.projectId),
          }}
        />
      </div>
      {letterhead ? <A4Document spec={poSpec(po)} letterhead={letterhead} /> : null}
      <section data-noprint className="rounded-lg border border-line bg-white p-4 text-[13px]">
        <h2 className="mb-2 font-semibold">Bills against this PO</h2>
        {po.bills.length === 0 ? <p className="text-muted">None yet.</p> : null}
        {po.bills.map((b) => (
          <p key={b.id} className="flex justify-between gap-3">
            <span>
              <span className="font-mono">{b.billNo}</span> · {formatDate(b.billDate)}
            </span>
            <span className="num">
              {rupees(b.taxable)} taxable · {rupees(b.total)}
            </span>
          </p>
        ))}
      </section>
    </div>
  );
}
