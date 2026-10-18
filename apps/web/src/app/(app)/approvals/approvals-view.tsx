'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CATEGORY_LABEL, formatDate } from '@csd/core';
import type { ApprovalQueue, Expense, VendorPayment } from '@csd/services';
import { Button, EmptyState, FormError } from '@/components/ui';
import { PageHeader, Segmented } from '@/components/kit';
import { useAction } from '@/components/sales/use-action';
import { apiFetch } from '@/lib/client';
import { istDateTime, rupees } from '@/lib/format';
import { EXPENSE_MODE_LABEL } from '@/lib/purchases';
import { MODE_LABEL } from '@/lib/sales';
import { SecureImage } from '@/components/purchases/secure-image';
import { PhotoLightbox } from '../expenses/expenses-view';

type Tab = 'expenses' | 'payments' | 'payroll' | 'rates' | 'discounts';

/** Entries dated on or before the lock date cannot post; they can only be rejected (BUG-113). */
const isLocked = (date: string, lockDate: string | null) => lockDate !== null && date <= lockDate;

export function ApprovalsView({
  queue,
  lockDate,
}: {
  queue: ApprovalQueue;
  lockDate: string | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('expenses');
  const [photo, setPhoto] = useState<Expense | null>(null);
  const approvable = queue.expenses.filter((e) => !isLocked(e.txnDate, lockDate));
  const { busy, error, setError, run } = useAction();
  const reject = (url: string) => {
    const reason = window.prompt('Reason for rejecting (the submitter sees this):');
    if (reason === null) return;
    void run(() => apiFetch(url, { method: 'POST', body: { reason } }));
  };
  const approveAll = () =>
    run(
      () =>
        apiFetch<{ failed: { id: string; message: string }[] }>('/api/v1/expenses/approve-bulk', {
          method: 'POST',
          body: { items: approvable.map((e) => ({ id: e.id, version: e.version })) },
        }),
      (r) => {
        const failed = (r as { failed: { message: string }[] }).failed;
        router.refresh();
        if (failed.length > 0)
          setError(`${failed.length} could not be approved: ${failed[0]?.message ?? ''}`);
      },
    );
  const pr = queue.payroll;
  const counts = {
    expenses: queue.expenses.length,
    payments: queue.payments.length,
    payroll: pr.runs.length + pr.advances.length + pr.payments.length,
    rates: queue.rateChanges.length,
    discounts: queue.discounts.length,
  };
  const empty = Object.values(counts).every((n) => n === 0);
  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Everything entered by someone else waits here before it reaches the books."
        action={
          tab === 'expenses' && approvable.length > 1 ? (
            <Button onClick={approveAll} disabled={busy}>
              Approve all ({approvable.length})
            </Button>
          ) : null
        }
      />
      <div className="mb-4">
        <Segmented<Tab>
          label="Approval type"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'expenses', label: `Expenses · ${counts.expenses}` },
            { value: 'payments', label: `Payments · ${counts.payments}` },
            { value: 'payroll', label: `Payroll · ${counts.payroll}` },
            { value: 'rates', label: `Rate changes · ${counts.rates}` },
            { value: 'discounts', label: `Discounts · ${counts.discounts}` },
          ]}
        />
      </div>
      <FormError message={error} />
      {empty ? <EmptyState>All caught up.</EmptyState> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {tab === 'expenses'
          ? queue.expenses.map((e) => (
              <ExpenseCard
                key={e.id}
                e={e}
                busy={busy}
                locked={isLocked(e.txnDate, lockDate)}
                onPhoto={() => setPhoto(e)}
                onApprove={() =>
                  run(() =>
                    apiFetch(`/api/v1/expenses/${e.id}/approve`, {
                      method: 'POST',
                      body: { version: e.version },
                    }),
                  )
                }
                onReject={() => reject(`/api/v1/expenses/${e.id}/reject`)}
              />
            ))
          : null}
        {tab === 'payments'
          ? queue.payments.map((p) => (
              <PaymentCard
                key={p.id}
                p={p}
                busy={busy}
                locked={isLocked(p.payDate, lockDate)}
                onApprove={() =>
                  run(() => apiFetch(`/api/v1/vendor-payments/${p.id}/approve`, { method: 'POST' }))
                }
                onReject={() => reject(`/api/v1/vendor-payments/${p.id}/reject`)}
              />
            ))
          : null}
        {tab === 'payroll' ? (
          <PayrollCards queue={queue} lockDate={lockDate} busy={busy} run={run} reject={reject} />
        ) : null}
        {tab === 'rates'
          ? queue.rateChanges.map((r) => (
              <article
                key={r.id}
                className="flex flex-col gap-1 rounded-lg border border-line bg-white p-4 text-[13px]"
              >
                <div className="num text-[18px] font-semibold">
                  {rupees(r.oldValue)} → {rupees(r.newValue)}
                </div>
                <div>
                  {RATE_LABEL[r.field]} · {r.targetName}
                  {r.projectCode ? ` · ${r.projectCode}` : ''}
                  {r.tdsRate !== null ? ` · TDS u/s 194C ${r.tdsRate}%` : ''}
                </div>
                <div className="text-xs text-subtle">
                  {r.submittedBy ?? 'Someone'} · entered {istDateTime(r.submittedAt)}
                </div>
                <Decide
                  busy={busy}
                  locked={false}
                  onApprove={() =>
                    run(() =>
                      apiFetch(`/api/v1/payroll/rate-changes/${r.id}/approve`, { method: 'POST' }),
                    )
                  }
                  onReject={() => reject(`/api/v1/payroll/rate-changes/${r.id}/reject`)}
                />
              </article>
            ))
          : null}
        {tab === 'discounts'
          ? queue.discounts.map((q) => (
              <article
                key={q.id}
                className="flex flex-col gap-2 rounded-lg border border-line bg-white p-4 text-[13px]"
              >
                <div className="num text-[18px] font-semibold">{q.discountPct}% discount</div>
                <div>
                  <Link href={`/quotes/${q.id}`} className="font-mono text-primary">
                    {q.number}
                  </Link>{' '}
                  · {q.clientName} · {q.title}
                </div>
                <div className="text-muted">Quote total after discount {rupees(q.total)}</div>
                <div className="flex justify-end">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        apiFetch(`/api/v1/quotations/${q.id}/approve-discount`, {
                          method: 'POST',
                          body: { version: q.version },
                        }),
                      )
                    }
                  >
                    Approve discount
                  </Button>
                </div>
              </article>
            ))
          : null}
      </div>
      {photo?.attachmentId ? (
        <PhotoLightbox
          id={photo.attachmentId}
          type={photo.attachmentType}
          onClose={() => setPhoto(null)}
        />
      ) : null}
    </>
  );
}

function Decide({
  busy,
  locked,
  onApprove,
  onReject,
}: {
  busy: boolean;
  locked: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      {locked ? (
        <span className="mr-auto text-xs text-warn">
          Locked period: reject, or move the lock date.
        </span>
      ) : null}
      <Button variant="ghost" onClick={onReject} disabled={busy}>
        Reject
      </Button>
      {locked ? null : (
        <Button onClick={onApprove} disabled={busy}>
          Approve
        </Button>
      )}
    </div>
  );
}

function ExpenseCard({
  e,
  busy,
  locked,
  onPhoto,
  onApprove,
  onReject,
}: {
  e: Expense;
  busy: boolean;
  locked: boolean;
  onPhoto: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <article className="flex gap-3 rounded-lg border border-line bg-white p-4 text-[13px]">
      {e.attachmentId ? (
        <button
          type="button"
          onClick={onPhoto}
          aria-label="View bill photo"
          className="flex h-[84px] w-[84px] shrink-0 items-center justify-center overflow-hidden rounded-md bg-track"
        >
          {e.attachmentType === 'application/pdf' ? (
            <span className="text-xs font-semibold text-muted">PDF</span>
          ) : (
            // The thumbnail, never the full photo: opening the photo is the audited view.
            <SecureImage
              src={`/api/v1/attachments/${e.attachmentId}/thumbnail`}
              alt=""
              className="h-full w-full object-cover"
              fallback="Photo"
            />
          )}
        </button>
      ) : (
        <div className="flex h-[84px] w-[84px] shrink-0 items-center justify-center rounded-md bg-track text-xs text-subtle">
          No photo
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="num text-[18px] font-semibold">{rupees(e.amount)}</div>
        <div className="truncate">{e.particulars}</div>
        <div className="text-muted">
          {CATEGORY_LABEL[e.category]} · {e.projectCode}
        </div>
        <div className="text-muted">
          {e.paidBy} · {EXPENSE_MODE_LABEL[e.mode]}
          {e.paidTo ? ` · to ${e.paidTo}` : ''}
        </div>
        <div className="text-xs text-subtle">
          {e.submittedBy ?? 'Someone'} · {formatDate(e.txnDate)} · entered{' '}
          {istDateTime(e.submittedAt)}
        </div>
        <Decide busy={busy} locked={locked} onApprove={onApprove} onReject={onReject} />
      </div>
    </article>
  );
}

function PaymentCard({
  p,
  busy,
  locked,
  onApprove,
  onReject,
}: {
  p: VendorPayment;
  busy: boolean;
  locked: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <article className="flex flex-col gap-1 rounded-lg border border-line bg-white p-4 text-[13px]">
      <div className="num text-[18px] font-semibold">{rupees(p.amount)}</div>
      <div>
        Pay {p.vendorName} · bill <span className="font-mono">{p.billNo}</span> · {p.projectCode}
      </div>
      <div className="text-muted">
        {MODE_LABEL[p.mode]}
        {p.reference ? ` · ${p.reference}` : ''}
        {p.tds > 0 ? ` · TDS ${rupees(p.tds)}` : ''}
        {p.paidBy ? ` · ${p.paidBy}` : ''}
      </div>
      <div className="text-xs text-subtle">
        {p.submittedBy ?? 'Someone'} · {formatDate(p.payDate)} · entered{' '}
        {istDateTime(p.submittedAt)}
      </div>
      <Decide busy={busy} locked={locked} onApprove={onApprove} onReject={onReject} />
    </article>
  );
}

const RATE_LABEL = {
  monthly_gross: 'Monthly salary',
  daily_rate: 'Daily rate',
  job_value: 'Contract job value',
} as const;

const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Approvals → Payroll (H2): payroll runs, salary advances, wage and contractor payments. */
function PayrollCards({
  queue,
  lockDate,
  busy,
  run,
  reject,
}: {
  queue: ApprovalQueue;
  lockDate: string | null;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  reject: (url: string) => void;
}) {
  const post = (url: string) => run(() => apiFetch(url, { method: 'POST' }));
  const card = 'flex flex-col gap-1 rounded-lg border border-line bg-white p-4 text-[13px]';
  return (
    <>
      {queue.payroll.runs.map((r) => (
        <article key={r.id} className={card}>
          <div className="num text-[18px] font-semibold">{rupees(r.totals.net)} net</div>
          <div>
            Payroll for {MONTH.format(new Date(`${r.period}-01T00:00:00Z`))} · {r.staff} staff ·{' '}
            <Link href={`/payroll/runs/${r.id}`} className="text-primary">
              payslips
            </Link>
          </div>
          <div className="text-muted">
            Gross {rupees(r.totals.gross)} · TDS {rupees(r.totals.tds)} · PT {rupees(r.totals.pt)} ·
            recovery {rupees(r.totals.recovery)} · {MODE_LABEL[r.mode]}
          </div>
          <div className="text-xs text-subtle">
            {r.submittedBy ?? 'Someone'} · pay date {formatDate(r.payDate)} · entered{' '}
            {istDateTime(r.submittedAt)}
          </div>
          <Decide
            busy={busy}
            locked={isLocked(r.payDate, lockDate)}
            onApprove={() => void post(`/api/v1/payroll/runs/${r.id}/approve`)}
            onReject={() => reject(`/api/v1/payroll/runs/${r.id}/reject`)}
          />
        </article>
      ))}
      {queue.payroll.advances.map((a) => (
        <article key={a.id} className={card}>
          <div className="num text-[18px] font-semibold">{rupees(a.amount)}</div>
          <div>Salary advance to {a.employeeName}</div>
          <div className="text-muted">
            {MODE_LABEL[a.mode]}
            {a.reference ? ` · ${a.reference}` : ''}
          </div>
          <div className="text-xs text-subtle">
            {a.submittedBy ?? 'Someone'} · {formatDate(a.advDate)} · entered{' '}
            {istDateTime(a.submittedAt)}
          </div>
          <Decide
            busy={busy}
            locked={isLocked(a.advDate, lockDate)}
            onApprove={() => void post(`/api/v1/payroll/advances/${a.id}/approve`)}
            onReject={() => reject(`/api/v1/payroll/advances/${a.id}/reject`)}
          />
        </article>
      ))}
      {queue.payroll.payments.map((p) => {
        const base =
          p.kind === 'wage' ? '/api/v1/labour/wages' : '/api/v1/labour/contract-payments';
        return (
          <article key={p.id} className={card}>
            <div className="num text-[18px] font-semibold">{rupees(p.amount)}</div>
            <div>
              {p.kind === 'wage' ? 'Wages to' : 'Contractor payment to'} {p.payee} · {p.detail} ·{' '}
              {p.projectCode}
            </div>
            <div className="text-muted">
              {MODE_LABEL[p.mode]}
              {p.reference ? ` · ${p.reference}` : ''}
              {p.tds > 0 ? ` · TDS ${rupees(p.tds)}` : ''}
            </div>
            <div className="text-xs text-subtle">
              {p.submittedBy ?? 'Someone'} · {formatDate(p.payDate)} · entered{' '}
              {istDateTime(p.submittedAt)}
            </div>
            <Decide
              busy={busy}
              locked={isLocked(p.payDate, lockDate)}
              onApprove={() => void post(`${base}/${p.id}/approve`)}
              onReject={() => reject(`${base}/${p.id}/reject`)}
            />
          </article>
        );
      })}
    </>
  );
}
