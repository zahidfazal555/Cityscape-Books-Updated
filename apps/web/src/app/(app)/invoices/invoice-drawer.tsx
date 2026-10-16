'use client';

import { useState } from 'react';
import { todayIn } from '@csd/core';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Drawer } from '@/components/kit';
import { LineGrid, blankLine, previewTotals, toLines } from '@/components/sales/line-grid';
import {
  selectCls,
  textareaCls,
  useAction,
  type ProjectOption,
} from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';

/** New tax invoice (README §5): project, dates, lines; GST split from the project's client. */
export function InvoiceDrawer({
  projects,
  companyStateCode,
  onClose,
  onSaved,
}: {
  projects: ProjectOption[];
  companyStateCode: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [projectId, setProjectId] = useState(projects.length === 1 ? (projects[0]?.id ?? '') : '');
  const [invoiceDate, setInvoiceDate] = useState(todayIn());
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([blankLine()]);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const project = projects.find((p) => p.id === projectId);
  const totals = previewTotals(lines, {
    placeOfSupply: project?.clientStateCode ?? null,
    companyStateCode,
  });

  const save = () =>
    run(
      () =>
        apiFetch<{ id: string }>('/api/v1/invoices', {
          method: 'POST',
          idempotencyKey,
          body: {
            projectId,
            invoiceDate,
            ...(dueDate ? { dueDate } : {}),
            lines: toLines(lines),
            notes: notes.trim() || null,
          },
        }),
      (r) => onSaved((r as { id: string }).id),
    );

  return (
    <Drawer
      title="New tax invoice"
      width={860}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Issuing…' : 'Issue invoice'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Project"
          htmlFor="i-project"
          hint={project ? `Bill to ${project.clientName}` : undefined}
        >
          <select
            id="i-project"
            className={selectCls}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Choose a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Invoice date" htmlFor="i-date">
            <Input
              id="i-date"
              type="date"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
            />
          </Field>
          <Field
            label="Due date"
            htmlFor="i-due"
            hint="Blank = the client's payment terms (else 15 days)."
          >
            <Input
              id="i-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </Field>
        </div>
        <LineGrid lines={lines} onChange={setLines} totals={totals} />
        <Field label="Notes (optional)" htmlFor="i-notes">
          <textarea
            id="i-notes"
            className={textareaCls}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
