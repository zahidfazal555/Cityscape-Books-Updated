'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDate, parseRupees } from '@csd/core';
import type { Employee, PayrollLine, PayrollRun, StaffAdvance } from '@csd/services';
import { Button, EmptyState, Field, FormError } from '@/components/ui';
import { Pill, Row, Table } from '@/components/kit';
import { MoneyDrawer } from '@/components/payroll/money-drawer';
import { EmployeeDrawer } from '@/components/payroll/forms';
import { selectCls, useAction } from '@/components/sales/use-action';
import { apiFetch } from '@/lib/client';
import { rupees, toRupeeInput } from '@/lib/format';

export interface PayrollRights {
  edit: boolean;
  full: boolean;
  owner: boolean;
  me: string;
  /** Books lock date: posted entries on or before it cannot be reversed (BUG-151). */
  lockDate: string | null;
}

const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'long', timeZone: 'UTC' });
export const monthName = (period: string) => MONTH.format(new Date(`${period}-01T00:00:00Z`));

export const STATUS_PILL = {
  pending: <Pill tone="amber">Waiting for owner</Pill>,
  approved: <Pill tone="green">Posted</Pill>,
  rejected: <Pill tone="red">Rejected</Pill>,
} as const;

/** "₹X waiting" for a pending rate change, with Withdraw for its author or `payroll = full` (BUG-152). */
export function PendingRate({
  pending,
  rights,
}: {
  pending: { id: string; value: number; createdBy: string | null };
  rights: PayrollRights;
}) {
  const { busy, error, run } = useAction();
  return (
    <span className="block text-xs text-warn">
      {rupees(pending.value)} waiting
      {rights.full || pending.createdBy === rights.me ? (
        <button
          type="button"
          className="ml-2 text-primary"
          disabled={busy}
          onClick={() =>
            void run(() =>
              apiFetch(`/api/v1/payroll/rate-changes/${pending.id}`, { method: 'DELETE' }),
            )
          }
        >
          Withdraw
        </button>
      ) : null}
      {error ? <span className="block text-danger">{error}</span> : null}
    </span>
  );
}

/** Asks for a new figure and sends it as a rate change (H2: pending unless the Owner). */
export function useRateChange() {
  const { busy, error, run } = useAction();
  const ask = (url: string, what: string, current: number) => {
    const raw = window.prompt(`New ${what} (₹)`, toRupeeInput(current));
    if (raw === null || raw.trim() === '') return;
    void run(() =>
      apiFetch(url, { method: 'POST', body: { value: parseRupees(raw.trim(), 'value') } }),
    );
  };
  return { busy, error, ask };
}

/** README §14, Monthly staff (FR-17.1). `periods` are the months that can be processed (BUG-149). */
export function StaffView({
  staff,
  preview,
  runs,
  advances,
  period,
  periods,
  rights,
}: {
  staff: Employee[];
  preview: PayrollLine[];
  runs: PayrollRun[];
  advances: StaffAdvance[];
  period: string;
  periods: string[];
  rights: PayrollRights;
}) {
  const router = useRouter();
  const [drawer, setDrawer] = useState<'employee' | 'advance' | 'run' | null>(null);
  const [advanceFor, setAdvanceFor] = useState('');
  const rate = useRateChange();
  const done = () => {
    setDrawer(null);
    router.refresh();
  };
  const live = runs.find((r) => r.period === period && r.status !== 'rejected');
  const byId = new Map(preview.map((l) => [l.employeeId, l]));
  const active = staff.filter((e) => e.isActive);
  const total = preview.reduce((n, l) => n + l.net, 0);
  return (
    <div className="flex flex-col gap-5">
      {rights.edit ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <label htmlFor="pay-period" className="text-[13px] text-muted">
            Month
          </label>
          <select
            id="pay-period"
            className={`${selectCls} w-auto`}
            value={period}
            onChange={(e) => router.push(`/payroll?period=${e.target.value}`)}
          >
            {periods.map((p) => (
              <option key={p} value={p}>
                {monthName(p)} {p.slice(0, 4)}
              </option>
            ))}
          </select>
          <Button variant="ghost" onClick={() => setDrawer('employee')}>
            + Add employee
          </Button>
          <Button
            variant="ghost"
            onClick={() => setDrawer('advance')}
            disabled={active.length === 0}
          >
            Salary advance
          </Button>
          <Button onClick={() => setDrawer('run')} disabled={!!live || preview.length === 0}>
            {live
              ? `${monthName(period)} payroll processed`
              : `Process ${monthName(period)} payroll`}
          </Button>
        </div>
      ) : null}
      <FormError message={rate.error} />
      {staff.length === 0 ? (
        <EmptyState>No staff yet.</EmptyState>
      ) : (
        <Table columns="1.6fr 1.2fr 1fr 0.8fr 0.8fr 0.9fr 1fr 0.9fr" minWidth={1000}>
          <Row head>
            <span>Name</span>
            <span>Designation</span>
            <span className="text-right">Gross</span>
            <span className="text-right">TDS</span>
            <span className="text-right">Prof. tax</span>
            <span className="text-right">Advance recovery</span>
            <span className="text-right">Net</span>
            <span />
          </Row>
          {staff.map((e) => {
            const l = byId.get(e.id);
            return (
              <Row key={e.id}>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{e.name}</span>
                  {e.advanceOutstanding > 0 ? (
                    <span className="block text-xs text-muted">
                      Advance due {rupees(e.advanceOutstanding)}
                    </span>
                  ) : null}
                </span>
                <span className="truncate text-muted">
                  {e.roleTitle}
                  {e.isActive ? '' : ' · inactive'}
                </span>
                <span className="num text-right">
                  {rupees(e.monthlyGross)}
                  {e.pendingRate ? <PendingRate pending={e.pendingRate} rights={rights} /> : null}
                </span>
                <span className="num text-right">{l ? rupees(l.tds) : '—'}</span>
                <span className="num text-right">{l ? rupees(l.pt) : '—'}</span>
                <span className="num text-right">{l ? rupees(l.recovery) : '—'}</span>
                <span className="num text-right font-medium">{l ? rupees(l.net) : '—'}</span>
                <span className="text-right">
                  {rights.edit && !e.pendingRate ? (
                    <button
                      type="button"
                      className="text-xs text-primary"
                      disabled={rate.busy}
                      onClick={() =>
                        rate.ask(
                          `/api/v1/payroll/employees/${e.id}/rate`,
                          'monthly gross',
                          e.monthlyGross,
                        )
                      }
                    >
                      Change salary
                    </button>
                  ) : null}
                </span>
              </Row>
            );
          })}
        </Table>
      )}
      <p className="text-[13px] text-muted">
        Net to pay for {monthName(period)}:{' '}
        <strong className="num text-ink">{rupees(total)}</strong>. Professional tax is deducted in
        the September and March runs.
      </p>

      <Runs runs={runs} rights={rights} />

      <Advances advances={advances} rights={rights} />

      {drawer === 'employee' ? (
        <EmployeeDrawer
          kind="salaried"
          projects={[]}
          isOwner={rights.owner}
          onClose={() => setDrawer(null)}
          onSaved={done}
        />
      ) : null}
      {drawer === 'run' ? (
        <MoneyDrawer
          title={`Process ${monthName(period)} payroll`}
          url="/api/v1/payroll/runs"
          isOwner={rights.owner}
          amount={null}
          dateLabel="Pay date"
          summary={`${preview.length} staff · net ${rupees(total)} · a payslip for each.`}
          body={(f) => ({ period, payDate: f.date, mode: f.mode, reference: f.reference })}
          onClose={() => setDrawer(null)}
          onSaved={done}
        />
      ) : null}
      {drawer === 'advance' ? (
        <MoneyDrawer
          title="Salary advance"
          url="/api/v1/payroll/advances"
          isOwner={rights.owner}
          amount={0}
          amountHint="Recovered from later salaries at the employee's monthly instalment."
          body={(f) => ({
            employeeId: advanceFor,
            advDate: f.date,
            amount: f.amount,
            mode: f.mode,
            reference: f.reference,
          })}
          onClose={() => setDrawer(null)}
          onSaved={done}
        >
          <Field label="Employee" htmlFor="adv-emp">
            <select
              id="adv-emp"
              className={selectCls}
              value={advanceFor}
              onChange={(e) => setAdvanceFor(e.target.value)}
            >
              <option value="">Choose</option>
              {active.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
        </MoneyDrawer>
      ) : null}
    </div>
  );
}

/**
 * Pending: its author or `payroll = full` (BUG-148). Posted: the Owner only, and only in an open
 * period, since the reversal is dated on the entry (BUG-151).
 */
export function canRemove(
  e: { status: string; createdBy: string | null },
  date: string,
  rights: PayrollRights,
): boolean {
  if (e.status === 'approved')
    return rights.owner && (rights.lockDate === null || date > rights.lockDate);
  return e.status === 'pending' && (rights.full || (rights.edit && e.createdBy === rights.me));
}

export const removeQuestion = (status: string, noun: string) =>
  status === 'pending'
    ? `Withdraw this ${noun}? It has not reached the books.`
    : `Reverse this ${noun}? A reversing entry is posted on its date.`;

function Runs({ runs, rights }: { runs: PayrollRun[]; rights: PayrollRights }) {
  const remove = useAction();
  return (
    <section>
      <h2 className="mb-2 text-[15px] font-semibold">Payroll runs</h2>
      <FormError message={remove.error} />
      {runs.length === 0 ? (
        <EmptyState>No payroll processed yet.</EmptyState>
      ) : (
        <Table columns="1fr 0.9fr 1fr 1fr 1fr 1.1fr 1.2fr" minWidth={900}>
          <Row head>
            <span>Month</span>
            <span>Paid on</span>
            <span className="text-right">Gross</span>
            <span className="text-right">Deductions</span>
            <span className="text-right">Net</span>
            <span>Status</span>
            <span />
          </Row>
          {runs.map((r) => (
            <Row key={r.id}>
              <span>
                {monthName(r.period)} {r.period.slice(0, 4)}
              </span>
              <span className="text-muted">{formatDate(r.payDate)}</span>
              <span className="num text-right">{rupees(r.totals.gross)}</span>
              <span className="num text-right">
                {rupees(r.totals.tds + r.totals.pt + r.totals.recovery)}
              </span>
              <span className="num text-right font-medium">{rupees(r.totals.net)}</span>
              <span title={r.rejectReason ?? undefined}>{STATUS_PILL[r.status]}</span>
              <span className="flex justify-end gap-3 text-xs">
                <Link href={`/payroll/runs/${r.id}`} className="text-primary">
                  Payslips
                </Link>
                {canRemove(r, r.payDate, rights) ? (
                  <button
                    type="button"
                    className="text-danger"
                    disabled={remove.busy}
                    onClick={() => {
                      if (!window.confirm(removeQuestion(r.status, 'payroll run'))) return;
                      void remove.run(() =>
                        apiFetch(`/api/v1/payroll/runs/${r.id}`, { method: 'DELETE' }),
                      );
                    }}
                  >
                    {r.status === 'pending' ? 'Withdraw' : 'Reverse'}
                  </button>
                ) : null}
              </span>
            </Row>
          ))}
        </Table>
      )}
    </section>
  );
}

function Advances({ advances, rights }: { advances: StaffAdvance[]; rights: PayrollRights }) {
  const remove = useAction();
  if (advances.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-[15px] font-semibold">Salary advances</h2>
      <FormError message={remove.error} />
      <Table columns="1.5fr 0.9fr 1fr 1.1fr 0.8fr" minWidth={700}>
        <Row head>
          <span>Employee</span>
          <span>Date</span>
          <span className="text-right">Amount</span>
          <span>Status</span>
          <span />
        </Row>
        {advances.map((a) => (
          <Row key={a.id}>
            <span>{a.employeeName}</span>
            <span className="text-muted">{formatDate(a.advDate)}</span>
            <span className="num text-right">{rupees(a.amount)}</span>
            <span title={a.rejectReason ?? undefined}>{STATUS_PILL[a.status]}</span>
            <span className="text-right text-xs">
              {canRemove(a, a.advDate, rights) ? (
                <button
                  type="button"
                  className="text-danger"
                  disabled={remove.busy}
                  onClick={() => {
                    if (!window.confirm(removeQuestion(a.status, 'advance'))) return;
                    void remove.run(() =>
                      apiFetch(`/api/v1/payroll/advances/${a.id}`, { method: 'DELETE' }),
                    );
                  }}
                >
                  {a.status === 'pending' ? 'Withdraw' : 'Reverse'}
                </button>
              ) : null}
            </span>
          </Row>
        ))}
      </Table>
    </section>
  );
}
