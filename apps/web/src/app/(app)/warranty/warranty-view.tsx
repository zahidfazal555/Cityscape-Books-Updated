'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { WARRANTY_MONTHS, formatDate, todayIn } from '@csd/core';
import type { WarrantyRow } from '@csd/services';
import { Button, EmptyState, Field, FormError, Input } from '@/components/ui';
import { Chips, Drawer, Pill, Row, Table } from '@/components/kit';
import { useAction } from '@/components/sales/use-action';
import { apiFetch } from '@/lib/client';
import { rupees } from '@/lib/format';
import { WARRANTY_LABEL, WARRANTY_TONE } from '@/lib/support';

const PERIOD_LABEL: Record<number, string> = {
  6: '6 months',
  12: '1 year',
  24: '2 years',
  60: '5 years',
};

export function WarrantyView({ rows, canEdit }: { rows: WarrantyRow[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<WarrantyRow | null>(null);
  if (rows.length === 0) return <EmptyState>No projects yet.</EmptyState>;
  return (
    <>
      <Table columns="0.8fr 2fr 0.9fr 1.2fr 1.1fr 0.9fr 0.8fr 0.9fr" minWidth={1100}>
        <Row head>
          <span>Project</span>
          <span>Name · client</span>
          <span>Handover</span>
          <span>Warranty ends</span>
          <span>Status</span>
          <span>AMC</span>
          <span className="text-right">Tickets</span>
          <span className="text-right">Repair cost</span>
        </Row>
        {rows.map((r) => (
          <Row key={r.projectId} {...(canEdit ? { onClick: () => setEditing(r) } : {})}>
            {canEdit ? (
              <button
                type="button"
                aria-label={`${r.handoverDate ? 'Edit warranty' : 'Record handover'} for ${r.projectCode}`}
                className="text-left font-mono text-[12px] text-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(r);
                }}
              >
                {r.projectCode}
              </button>
            ) : (
              <span className="font-mono text-[12px]">{r.projectCode}</span>
            )}
            <span className="min-w-0">
              <span className="block truncate">{r.projectName}</span>
              <span className="block truncate text-xs text-muted">{r.clientName}</span>
            </span>
            <span>{r.handoverDate ? formatDate(r.handoverDate) : '—'}</span>
            <span>
              {r.warrantyEnd ? formatDate(r.warrantyEnd) : '—'}
              {r.daysLeft !== null && r.daysLeft >= 0 ? (
                <span className="block text-xs text-muted">{r.daysLeft} days left</span>
              ) : null}
            </span>
            <span>
              <Pill tone={WARRANTY_TONE[r.status]}>{WARRANTY_LABEL[r.status]}</Pill>
            </span>
            <span className="text-muted">{r.amcUntil ? formatDate(r.amcUntil) : '—'}</span>
            <span className="num text-right">
              {r.openTickets}/{r.totalTickets}
            </span>
            <span className="num text-right">{rupees(r.repairCost)}</span>
          </Row>
        ))}
      </Table>
      {editing ? <HandoverDrawer row={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

/** FR-20.2: handover date (not future, not before the start), period, AMC valid till. */
function HandoverDrawer({ row, onClose }: { row: WarrantyRow; onClose: () => void }) {
  const router = useRouter();
  const [handoverDate, setHandover] = useState(row.handoverDate ?? todayIn());
  const [months, setMonths] = useState(String(row.warrantyMonths));
  const [amcUntil, setAmc] = useState(row.amcUntil ?? '');
  const { busy, error, run } = useAction();
  const save = () =>
    run(
      () =>
        apiFetch(`/api/v1/projects/${row.projectId}/warranty`, {
          method: 'PATCH',
          body: { handoverDate, warrantyMonths: Number(months), amcUntil: amcUntil || null },
        }),
      () => {
        onClose();
        router.refresh();
      },
    );
  return (
    <Drawer
      title={`${row.handoverDate ? 'Edit warranty' : 'Record handover'} · ${row.projectCode}`}
      width={440}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Handover date"
          htmlFor="w-date"
          hint={`Project started ${formatDate(row.startDate)}.`}
        >
          <Input
            id="w-date"
            type="date"
            value={handoverDate}
            onChange={(e) => setHandover(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-body">Warranty period</span>
          <Chips
            label="Warranty period"
            options={WARRANTY_MONTHS.map((m) => ({
              value: String(m),
              label: PERIOD_LABEL[m] ?? `${m} months`,
            }))}
            value={months}
            onChange={setMonths}
          />
        </div>
        <Field label="AMC valid till" htmlFor="w-amc" hint="Optional.">
          <Input id="w-amc" type="date" value={amcUntil} onChange={(e) => setAmc(e.target.value)} />
        </Field>
        {row.handoverDate ? null : (
          <p className="text-[13px] text-muted">Saving marks the project Completed.</p>
        )}
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
