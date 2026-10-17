import Link from 'next/link';
import { formatDate, isPtMonth } from '@csd/core';
import { EmptyState } from '@/components/ui';
import { PrintButton } from '@/components/payroll/print-button';
import { rupees } from '@/lib/format';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';
import { MODE_LABEL } from '@/lib/sales';

const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Payslips for a payroll run, one per page when printed (FR-17.1). */
export default async function PayslipsPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, company } = await getSession();
  const { id } = await params;
  const run = await services()
    .payroll.run(actor, id)
    .catch(() => null);
  if (!run) return <EmptyState>Payroll run not found.</EmptyState>;
  const month = MONTH.format(new Date(`${run.period}-01T00:00:00Z`));
  return (
    <div className="flex flex-col gap-4">
      <div data-noprint className="flex items-center justify-between">
        <Link href="/payroll" className="text-[13px] text-primary">
          ← Payroll
        </Link>
        <PrintButton />
      </div>
      {run.status === 'approved' ? null : (
        <p className="rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-[13px] text-warn">
          This run is {run.status === 'pending' ? 'waiting for the owner' : 'rejected'}: these are
          drafts, not payslips.
        </p>
      )}
      {run.lines.map((l) => (
        <article
          key={l.employeeId}
          className="mx-auto w-full max-w-[720px] break-after-page rounded-lg border border-line bg-white p-8 text-[13px] print:border-0"
        >
          <header className="mb-6 flex items-start justify-between border-b border-line pb-4">
            <div>
              <div className="text-[18px] font-semibold">{company.name}</div>
              <div className="text-muted">Payslip · {month}</div>
            </div>
            <div className="text-right text-muted">
              Paid {formatDate(run.payDate)} · {MODE_LABEL[run.mode]}
            </div>
          </header>
          <div className="mb-5">
            <div className="text-[15px] font-semibold">{l.name}</div>
            <div className="text-muted">{l.roleTitle}</div>
          </div>
          <dl className="grid grid-cols-[1fr_auto] gap-y-2">
            <dt>Gross salary</dt>
            <dd className="num text-right">{rupees(l.gross)}</dd>
            <dt className="text-muted">Less: TDS on salary</dt>
            <dd className="num text-right">{rupees(l.tds)}</dd>
            <dt className="text-muted">
              Less: professional tax{isPtMonth(run.period) ? ' (half-year)' : ''}
            </dt>
            <dd className="num text-right">{rupees(l.pt)}</dd>
            <dt className="text-muted">Less: advance recovery</dt>
            <dd className="num text-right">{rupees(l.recovery)}</dd>
            <dt className="border-t border-line pt-2 font-semibold">Net pay</dt>
            <dd className="num border-t border-line pt-2 text-right font-semibold">
              {rupees(l.net)}
            </dd>
          </dl>
        </article>
      ))}
    </div>
  );
}
