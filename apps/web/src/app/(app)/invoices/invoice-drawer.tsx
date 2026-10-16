'use client';

import { useState } from 'react';
import { todayIn } from '@csd/core';
import type { InvoiceDetail } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Drawer } from '@/components/kit';
import { LineGrid, blankLine, draftOf, previewTotals, toLines } from '@/components/sales/line-grid';
import {
  selectCls,
  textareaCls,
  useAction,
  type ProjectOption,
} from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';

function initialForm(invoice: InvoiceDetail | null, projects: ProjectOption[]) {
  return {
    projectId: invoice?.projectId ?? (projects.length === 1 ? (projects[0]?.id ?? '') : ''),
    invoiceDate: invoice?.invoiceDate ?? todayIn(),
    dueDate: invoice?.dueDate ?? '',
    notes: invoice?.notes ?? '',
    lines: invoice ? invoice.lines.map(draftOf) : [blankLine()],
  };
}

function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: ProjectOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  const project = projects.find((p) => p.id === value);
  return (
    <Field
      label="Project"
      htmlFor="i-project"
      hint={project ? `Bill to ${project.clientName}` : undefined}
    >
      <select
        id="i-project"
        className={selectCls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose a project…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.code} · {p.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * New or edit tax invoice (README §5): project, dates, lines; GST split from the project's
 * client. An edit keeps the number and project and is allowed only while nothing is received.
 */
export function InvoiceDrawer({
  invoice = null,
  projects,
  companyStateCode,
  onClose,
  onSaved,
}: {
  invoice?: InvoiceDetail | null;
  projects: ProjectOption[];
  companyStateCode: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [init] = useState(() => initialForm(invoice, projects));
  const [projectId, setProjectId] = useState(init.projectId);
  const [invoiceDate, setInvoiceDate] = useState(init.invoiceDate);
  const [dueDate, setDueDate] = useState(init.dueDate);
  const [notes, setNotes] = useState(init.notes);
  const [lines, setLines] = useState(init.lines);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const project = projects.find((p) => p.id === projectId);
  const totals = previewTotals(lines, {
    placeOfSupply: invoice?.placeOfSupply ?? project?.clientStateCode ?? null,
    companyStateCode,
  });

  const save = () =>
    run(
      async () => {
        const body = {
          invoiceDate,
          ...(dueDate ? { dueDate } : {}),
          lines: toLines(lines),
          notes: notes.trim() || null,
        };
        if (!invoice)
          return apiFetch<{ id: string }>('/api/v1/invoices', {
            method: 'POST',
            idempotencyKey,
            body: { projectId, ...body },
          });
        await apiFetch(`/api/v1/invoices/${invoice.id}`, {
          method: 'PATCH',
          body: { ...body, version: invoice.version },
        });
        return { id: invoice.id };
      },
      (r) => onSaved((r as { id: string }).id),
    );

  return (
    <Drawer
      title={invoice ? `Edit ${invoice.number}` : 'New tax invoice'}
      width={860}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : invoice ? 'Save changes' : 'Issue invoice'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {invoice ? (
          <p className="text-[13px] text-muted">
            {invoice.projectCode} · bill to {invoice.clientName}
          </p>
        ) : (
          <ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />
        )}
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
