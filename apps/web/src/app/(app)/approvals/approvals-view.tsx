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
import { PhotoLightbox } from '../expenses/expenses-view';

type Tab = 'expenses' | 'payments' | 'discounts';

export function ApprovalsView({ queue }: { queue: ApprovalQueue }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('expenses');
  const [photo, setPhoto] = useState<string | null>(null);
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
          body: { ids: queue.expenses.map((e) => e.id) },
        }),
      (r) => {
        const failed = (r as { failed: { message: string }[] }).failed;
        router.refresh();
        if (failed.length > 0)
          setError(`${failed.length} could not be approved: ${failed[0]?.message ?? ''}`);
      },
    );
  const counts = {
    expenses: queue.expenses.length,
    payments: queue.payments.length,
    discounts: queue.discounts.length,
  };
  const empty = counts.expenses + counts.payments + counts.discounts === 0;
  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Everything entered by someone else waits here before it reaches the books."
        action={
          tab === 'expenses' && counts.expenses > 1 ? (
            <Button onClick={approveAll} disabled={busy}>
              Approve all ({counts.expenses})
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
                onPhoto={() => setPhoto(e.attachmentId)}
                onApprove={() =>
                  run(() => apiFetch(`/api/v1/expenses/${e.id}/approve`, { method: 'POST' }))
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
                onApprove={() =>
                  run(() => apiFetch(`/api/v1/vendor-payments/${p.id}/approve`, { method: 'POST' }))
                }
                onReject={() => reject(`/api/v1/vendor-payments/${p.id}/reject`)}
              />
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
                        apiFetch(`/api/v1/quotations/${q.id}/approve-discount`, { method: 'POST' }),
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
      {photo ? <PhotoLightbox id={photo} onClose={() => setPhoto(null)} /> : null}
    </>
  );
}

function Decide({
  busy,
  onApprove,
  onReject,
}: {
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onReject} disabled={busy}>
        Reject
      </Button>
      <Button onClick={onApprove} disabled={busy}>
        Approve
      </Button>
    </div>
  );
}

function ExpenseCard({
  e,
  busy,
  onPhoto,
  onApprove,
  onReject,
}: {
  e: Expense;
  busy: boolean;
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
          className="h-[84px] w-[84px] shrink-0 overflow-hidden rounded-md bg-track"
        >
          <img
            src={`/api/v1/attachments/${e.attachmentId}`}
            alt=""
            className="h-full w-full object-cover"
          />
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
        <Decide busy={busy} onApprove={onApprove} onReject={onReject} />
      </div>
    </article>
  );
}

function PaymentCard({
  p,
  busy,
  onApprove,
  onReject,
}: {
  p: VendorPayment;
  busy: boolean;
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
      <Decide busy={busy} onApprove={onApprove} onReject={onReject} />
    </article>
  );
}
