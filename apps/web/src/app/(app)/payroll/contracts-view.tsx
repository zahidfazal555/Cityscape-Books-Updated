'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { contractTds } from '@csd/core';
import type { ContractJob, LabourPayment } from '@csd/services';
import { Button, EmptyState, FormError } from '@/components/ui';
import { Row, Table } from '@/components/kit';
import { JobDrawer } from '@/components/payroll/forms';
import { MoneyDrawer } from '@/components/payroll/money-drawer';
import { useAction, type ProjectOption } from '@/components/sales/use-action';
import { apiFetch } from '@/lib/client';
import { rupees } from '@/lib/format';
import { Payments } from './labour-view';
import { useRateChange, type PayrollRights } from './staff-view';

/** README §14, Contractors paid per job (FR-17.3). */
export function ContractsView({
  jobs,
  payments,
  projects,
  rights,
}: {
  jobs: ContractJob[];
  payments: LabourPayment[];
  projects: ProjectOption[];
  rights: PayrollRights;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<ContractJob | null>(null);
  const update = useAction();
  const value = useRateChange();
  const done = () => {
    setAdding(false);
    setPaying(null);
    router.refresh();
  };
  const setProgress = (j: ContractJob) => {
    const raw = window.prompt('Progress (%)', String(j.progress));
    if (raw === null) return;
    void update.run(() =>
      apiFetch(`/api/v1/labour/jobs/${j.id}`, {
        method: 'PATCH',
        body: { progress: Number(raw) },
      }),
    );
  };
  const toggleClosed = (j: ContractJob) =>
    void update.run(() =>
      apiFetch(`/api/v1/labour/jobs/${j.id}`, {
        method: 'PATCH',
        body: { isClosed: !j.isClosed },
      }),
    );
  return (
    <div className="flex flex-col gap-5">
      {rights.edit ? (
        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => setAdding(true)}>
            + Add contract job
          </Button>
        </div>
      ) : null}
      <FormError message={update.error ?? value.error} />
      {jobs.length === 0 ? (
        <EmptyState>No contract jobs yet.</EmptyState>
      ) : (
        <Table columns="1.8fr 0.8fr 1fr 1fr 1fr 1.1fr 1.3fr" minWidth={1040}>
          <Row head>
            <span>Contractor · work</span>
            <span>Project</span>
            <span className="text-right">Job value</span>
            <span className="text-right">Paid</span>
            <span className="text-right">Balance</span>
            <span>Progress</span>
            <span />
          </Row>
          {jobs.map((j) => (
            <Row key={j.id}>
              <span className="min-w-0">
                <span className="block truncate font-medium">{j.contractor}</span>
                <span className="block truncate text-xs text-muted">
                  {j.work} · TDS {j.tdsRate}%{j.isClosed ? ' · closed' : ''}
                </span>
              </span>
              <span className="font-mono text-[12px]">{j.projectCode}</span>
              <span className="num text-right">
                {rupees(j.value)}
                {j.pendingValue !== null ? (
                  <span className="block text-xs text-warn">{rupees(j.pendingValue)} waiting</span>
                ) : null}
              </span>
              <span className="num text-right">
                {rupees(j.paid)}
                {j.pending > 0 ? (
                  <span className="block text-xs text-warn">{rupees(j.pending)} waiting</span>
                ) : null}
              </span>
              <span className="num text-right font-medium">{rupees(j.balance)}</span>
              <span className="flex items-center gap-2">
                <span
                  className="h-1.5 flex-1 overflow-hidden rounded-full bg-track"
                  role="meter"
                  aria-label={`${j.contractor} progress`}
                  aria-valuenow={j.progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span className="block h-full bg-primary" style={{ width: `${j.progress}%` }} />
                </span>
                <span className="num text-xs text-muted">{j.progress}%</span>
              </span>
              {rights.edit ? (
                <span className="flex flex-wrap justify-end gap-3 text-xs">
                  <button type="button" className="text-primary" onClick={() => setProgress(j)}>
                    Progress
                  </button>
                  {j.pendingValue === null ? (
                    <button
                      type="button"
                      className="text-primary"
                      disabled={value.busy}
                      onClick={() =>
                        value.ask(`/api/v1/labour/jobs/${j.id}/value`, 'job value', j.value)
                      }
                    >
                      Value
                    </button>
                  ) : null}
                  <button type="button" className="text-primary" onClick={() => toggleClosed(j)}>
                    {j.isClosed ? 'Reopen' : 'Close'}
                  </button>
                  {!j.isClosed && j.balance > 0 ? (
                    <Button className="h-7 px-3 text-xs" onClick={() => setPaying(j)}>
                      Pay
                    </Button>
                  ) : null}
                </span>
              ) : (
                <span />
              )}
            </Row>
          ))}
        </Table>
      )}
      <Payments
        title="Contractor payments"
        payments={payments}
        url="/api/v1/labour/contract-payments"
        rights={rights}
      />
      {adding ? (
        <JobDrawer
          projects={projects}
          isOwner={rights.owner}
          onClose={() => setAdding(false)}
          onSaved={done}
        />
      ) : null}
      {paying ? (
        <MoneyDrawer
          title={`Pay ${paying.contractor}`}
          url="/api/v1/labour/contract-payments"
          isOwner={rights.owner}
          amount={paying.balance}
          amountLabel="Amount before TDS (₹)"
          amountHint={`TDS u/s 194C at ${paying.tdsRate}% is held back (e.g. ${rupees(
            contractTds(paying.balance, paying.tdsRate),
          )} on the full balance). Posted to the project's subcontract cost.`}
          summary={`${paying.work} · value ${rupees(paying.value)} · balance ${rupees(paying.balance)}`}
          body={(f) => ({
            jobId: paying.id,
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
