'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDate } from '@csd/core';
import type { LabourPayment, Worker } from '@csd/services';
import { Button, EmptyState, FormError } from '@/components/ui';
import { Row, Table } from '@/components/kit';
import { EmployeeDrawer } from '@/components/payroll/forms';
import { MoneyDrawer } from '@/components/payroll/money-drawer';
import { useAction, type ProjectOption } from '@/components/sales/use-action';
import { apiFetch } from '@/lib/client';
import { rupees } from '@/lib/format';
import { MODE_LABEL } from '@/lib/sales';
import {
  STATUS_PILL,
  canRemove,
  removeQuestion,
  useRateChange,
  type PayrollRights,
} from './staff-view';

const days = (tenths: number) => (tenths / 10).toLocaleString('en-IN');

/** README §14, Daily-wage labour (FR-17.2). */
export function LabourView({
  workers,
  payments,
  projects,
  rights,
}: {
  workers: Worker[];
  payments: LabourPayment[];
  projects: ProjectOption[];
  rights: PayrollRights;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<Worker | null>(null);
  const mark = useAction();
  const rate = useRateChange();
  const done = () => {
    setAdding(false);
    setPaying(null);
    router.refresh();
  };
  return (
    <div className="flex flex-col gap-5">
      {rights.edit ? (
        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => setAdding(true)}>
            + Add worker
          </Button>
        </div>
      ) : null}
      <FormError message={mark.error ?? rate.error} />
      {workers.length === 0 ? (
        <EmptyState>No daily-wage workers yet.</EmptyState>
      ) : (
        <Table columns="1.5fr 0.9fr 0.9fr 1fr 0.9fr 0.9fr 0.9fr 1.1fr" minWidth={1040}>
          <Row head>
            <span>Worker · trade</span>
            <span>Project</span>
            <span className="text-right">Rate / day</span>
            <span className="text-right">Days</span>
            <span className="text-right">Earned</span>
            <span className="text-right">Paid</span>
            <span className="text-right">Balance</span>
            <span />
          </Row>
          {workers.map((w) => (
            <Row key={w.id}>
              <span className="min-w-0">
                <span className="block truncate font-medium">{w.name}</span>
                <span className="block truncate text-xs text-muted">
                  {w.trade}
                  {w.isActive ? '' : ' · inactive'}
                </span>
              </span>
              <span className="font-mono text-[12px]">{w.projectCode}</span>
              <span className="num text-right">
                {w.dailyRate > 0 ? rupees(w.dailyRate) : '—'}
                {w.pendingRate !== null ? (
                  <span className="block text-xs text-warn">{rupees(w.pendingRate)} waiting</span>
                ) : null}
              </span>
              <span className="flex items-center justify-end gap-2">
                <span className="num">{days(w.tenths)}</span>
                {rights.edit && w.isActive && w.dailyRate > 0 ? (
                  <button
                    type="button"
                    aria-label={`Mark ${w.name} present today`}
                    title={w.markedToday ? 'Already marked today' : 'Mark present today'}
                    disabled={mark.busy || w.markedToday}
                    onClick={() =>
                      void mark.run(() =>
                        apiFetch(`/api/v1/labour/workers/${w.id}/attendance`, {
                          method: 'POST',
                          body: {},
                        }),
                      )
                    }
                    className="h-7 rounded-md border border-input px-2 text-xs font-semibold text-primary disabled:opacity-40"
                  >
                    +1
                  </button>
                ) : null}
              </span>
              <span className="num text-right">{rupees(w.earned)}</span>
              <span className="num text-right">
                {rupees(w.paid)}
                {w.pending > 0 ? (
                  <span className="block text-xs text-warn">{rupees(w.pending)} waiting</span>
                ) : null}
              </span>
              <span className="num text-right font-medium">{rupees(w.balance)}</span>
              <span className="flex justify-end gap-3 text-xs">
                {rights.edit && !w.pendingRate ? (
                  <button
                    type="button"
                    className="text-primary"
                    disabled={rate.busy}
                    onClick={() =>
                      rate.ask(`/api/v1/payroll/employees/${w.id}/rate`, 'daily rate', w.dailyRate)
                    }
                  >
                    Rate
                  </button>
                ) : null}
                {rights.edit && w.balance > 0 ? (
                  <Button className="h-7 px-3 text-xs" onClick={() => setPaying(w)}>
                    Pay wages
                  </Button>
                ) : null}
              </span>
            </Row>
          ))}
        </Table>
      )}
      <Payments
        title="Wage payments"
        payments={payments}
        url="/api/v1/labour/wages"
        rights={rights}
      />
      {adding ? (
        <EmployeeDrawer
          kind="daily"
          projects={projects}
          isOwner={rights.owner}
          onClose={() => setAdding(false)}
          onSaved={done}
        />
      ) : null}
      {paying ? (
        <MoneyDrawer
          title={`Pay wages · ${paying.name}`}
          url="/api/v1/labour/wages"
          isOwner={rights.owner}
          amount={paying.balance}
          amountHint="Posted to the project's labour cost."
          summary={`${days(paying.tenths)} days earned ${rupees(paying.earned)} · balance ${rupees(paying.balance)}`}
          body={(f) => ({
            employeeId: paying.id,
            payDate: f.date,
            amount: f.amount,
            mode: f.mode,
            reference: f.reference,
          })}
          onClose={() => setPaying(null)}
          onSaved={done}
        />
      ) : null}
    </div>
  );
}

/** Wage or contractor payments, with withdraw (pending) and reverse (Owner) actions. */
export function Payments({
  title,
  payments,
  url,
  rights,
}: {
  title: string;
  payments: LabourPayment[];
  url: string;
  rights: PayrollRights;
}) {
  const remove = useAction();
  if (payments.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-[15px] font-semibold">{title}</h2>
      <FormError message={remove.error} />
      <Table columns="0.9fr 1.6fr 0.8fr 1fr 0.8fr 0.9fr 1.1fr 0.8fr" minWidth={980}>
        <Row head>
          <span>Date</span>
          <span>Paid to</span>
          <span>Project</span>
          <span className="text-right">Amount</span>
          <span className="text-right">TDS</span>
          <span>Mode</span>
          <span>Status</span>
          <span />
        </Row>
        {payments.map((p) => (
          <Row key={p.id}>
            <span className="text-muted">{formatDate(p.payDate)}</span>
            <span className="min-w-0">
              <span className="block truncate">{p.payee}</span>
              <span className="block truncate text-xs text-muted">{p.detail}</span>
            </span>
            <span className="font-mono text-[12px]">{p.projectCode}</span>
            <span className="num text-right">{rupees(p.amount)}</span>
            <span className="num text-right">{p.tds > 0 ? rupees(p.tds) : '—'}</span>
            <span className="text-muted">{MODE_LABEL[p.mode]}</span>
            <span title={p.rejectReason ?? undefined}>{STATUS_PILL[p.status]}</span>
            <span className="text-right text-xs">
              {canRemove(p, rights) ? (
                <button
                  type="button"
                  className="text-danger"
                  disabled={remove.busy}
                  onClick={() => {
                    if (!window.confirm(removeQuestion(p.status, 'payment'))) return;
                    void remove.run(() => apiFetch(`${url}/${p.id}`, { method: 'DELETE' }));
                  }}
                >
                  {p.status === 'pending' ? 'Withdraw' : 'Reverse'}
                </button>
              ) : null}
            </span>
          </Row>
        ))}
      </Table>
    </section>
  );
}
