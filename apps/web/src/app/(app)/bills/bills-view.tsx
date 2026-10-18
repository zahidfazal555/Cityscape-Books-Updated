'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CATEGORY_LABEL, formatDate } from '@csd/core';
import type { BillDetail, BillSummary } from '@csd/services';
import { Button, EmptyState, FormError } from '@/components/ui';
import { PdfLink } from '@/components/accounts/tabs';
import { PageHeader, Pill, Row, Table } from '@/components/kit';
import { BillDrawer, type VendorOption } from '@/components/purchases/bill-drawer';
import { PayDrawer } from '@/components/purchases/pay-drawer';
import { Cards, FilterChips } from '@/components/sales/filter-chips';
import { useAction, type ProjectOption } from '@/components/sales/use-action';
import { apiFetch } from '@/lib/client';
import { rupees } from '@/lib/format';
import { BILL_STATUS } from '@/lib/purchases';

const FILTERS = [
  ['all', 'All'],
  ['unpaid', 'Unpaid'],
  ['partially_paid', 'Partially paid'],
  ['paid', 'Paid'],
  ['overdue', 'Overdue'],
] as const;

type Open =
  { kind: 'new' } | { kind: 'pay'; bill: BillSummary } | { kind: 'edit'; bill: BillDetail } | null;

export function BillsView({
  bills,
  filter,
  rights,
  lockDate,
  vendors,
  projects,
  companyStateCode,
}: {
  bills: BillSummary[];
  filter: string;
  rights: { edit: boolean; full: boolean; owner: boolean };
  lockDate: string | null;
  vendors: VendorOption[];
  projects: ProjectOption[];
  companyStateCode: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Open>(null);
  const { error, run } = useAction();
  const done = () => {
    setOpen(null);
    router.refresh();
  };
  const unlocked = (b: BillSummary) => lockDate === null || b.billDate > lockDate;
  const edit = (b: BillSummary) =>
    run(
      () => apiFetch<BillDetail>(`/api/v1/bills/${b.id}`),
      (detail) => setOpen({ kind: 'edit', bill: detail as BillDetail }),
    );
  const remove = (b: BillSummary) => {
    if (!window.confirm(`Delete bill ${b.billNo} from ${b.vendorName}? Its journal is reversed.`))
      return;
    void run(() => apiFetch(`/api/v1/bills/${b.id}`, { method: 'DELETE' }));
  };
  const sum = (k: 'total' | 'balance' | 'pending') => bills.reduce((s, b) => s + b[k], 0);
  return (
    <>
      <PageHeader
        title="Purchase bills"
        subtitle="Vendor bills and payments. Cost is booked to the project on the bill date."
        action={
          rights.edit ? <Button onClick={() => setOpen({ kind: 'new' })}>+ New bill</Button> : null
        }
      />
      <Cards
        items={[
          ['Billed (listed)', rupees(sum('total'))],
          ['Balance to pay', rupees(sum('balance'))],
          ['Waiting for approval', rupees(sum('pending'))],
        ]}
      />
      <FilterChips base="/bills" options={FILTERS} value={filter} />
      <FormError message={error} />
      {bills.length === 0 ? (
        <EmptyState>No bills here yet.</EmptyState>
      ) : (
        <Table
          columns="0.9fr 1.8fr 0.9fr 0.8fr 0.8fr 0.9fr 0.8fr 0.9fr 0.9fr 1.3fr"
          minWidth={1180}
        >
          <Row head>
            <span>Bill no</span>
            <span>Vendor</span>
            <span>Project</span>
            <span>Date</span>
            <span>Due</span>
            <span className="text-right">Amount</span>
            <span className="text-right">GST</span>
            <span className="text-right">Balance</span>
            <span>Status</span>
            <span />
          </Row>
          {bills.map((b) => (
            <Row key={b.id}>
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-[12px]">{b.billNo}</span>
                <PdfLink href={`/api/v1/bills/${b.id}/pdf`} />
              </span>
              <span className="min-w-0">
                <span className="block truncate">{b.vendorName}</span>
                <span className="block truncate text-xs text-muted">
                  {b.vendorGstin ?? 'Unregistered'} · {CATEGORY_LABEL[b.category]}
                  {b.purchaseOrderNumber ? ` · ${b.purchaseOrderNumber}` : ''}
                </span>
              </span>
              <span className="text-muted">{b.projectCode}</span>
              <span className="text-muted">{formatDate(b.billDate)}</span>
              <span className={b.status === 'overdue' ? 'text-danger' : 'text-muted'}>
                {formatDate(b.dueDate)}
              </span>
              <span className="num text-right">{rupees(b.total)}</span>
              <span className="num text-right text-muted">{rupees(b.gst)}</span>
              <span className="num text-right">
                {rupees(b.balance)}
                {b.pending > 0 ? (
                  <span className="block text-[11px] text-warn">{rupees(b.pending)} pending</span>
                ) : null}
              </span>
              <span>
                <Pill tone={BILL_STATUS[b.status].tone}>{BILL_STATUS[b.status].label}</Pill>
              </span>
              <span className="flex justify-end gap-2 text-[12.5px]">
                {rights.edit && b.balance - b.pending > 0 ? (
                  <button
                    type="button"
                    className="font-medium text-primary"
                    onClick={() => setOpen({ kind: 'pay', bill: b })}
                  >
                    Pay
                  </button>
                ) : null}
                {rights.edit && unlocked(b) ? (
                  <button type="button" className="text-primary" onClick={() => edit(b)}>
                    Edit
                  </button>
                ) : null}
                {rights.full && unlocked(b) && b.paid === 0 && b.pending === 0 ? (
                  <button type="button" className="text-danger" onClick={() => remove(b)}>
                    Delete
                  </button>
                ) : null}
              </span>
            </Row>
          ))}
        </Table>
      )}
      {open?.kind === 'new' ? (
        <BillDrawer
          vendors={vendors}
          projects={projects}
          companyStateCode={companyStateCode}
          onClose={() => setOpen(null)}
          onSaved={done}
        />
      ) : null}
      {open?.kind === 'edit' ? (
        <BillDrawer
          bill={open.bill}
          vendors={vendors}
          projects={projects}
          companyStateCode={companyStateCode}
          onClose={() => setOpen(null)}
          onSaved={done}
        />
      ) : null}
      {open?.kind === 'pay' ? (
        <PayDrawer
          bill={open.bill}
          isOwner={rights.owner}
          onClose={() => setOpen(null)}
          onSaved={done}
        />
      ) : null}
    </>
  );
}
