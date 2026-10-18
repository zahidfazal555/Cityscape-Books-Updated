'use client';

import { useState } from 'react';
import { addDays, todayIn } from '@csd/core';
import type { ProformaDetail } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Drawer } from '@/components/kit';
import { LineGrid, blankLine, draftOf, previewTotals, toLines } from '@/components/sales/line-grid';
import { selectCls, useAction, type ProjectOption } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';

/** New / edit proforma (README §4c): project, stage, date, payment due, lines. */
export function ProformaDrawer({
  proforma,
  projects,
  companyStateCode,
  onClose,
  onSaved,
}: {
  proforma: ProformaDetail | null;
  projects: ProjectOption[];
  companyStateCode: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [projectId, setProjectId] = useState(proforma?.projectId ?? '');
  const [stage, setStage] = useState(proforma?.stage ?? '');
  const [pfDate, setPfDate] = useState(proforma?.pfDate ?? todayIn());
  const [dueDate, setDueDate] = useState(proforma?.dueDate ?? addDays(todayIn(), 7));
  const [lines, setLines] = useState(() =>
    proforma ? proforma.lines.map(draftOf) : [blankLine()],
  );
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const pos = proforma?.placeOfSupply ?? projects.find((p) => p.id === projectId)?.clientStateCode;
  const totals = previewTotals(lines, { placeOfSupply: pos ?? null, companyStateCode });

  const save = () =>
    run(
      async () => {
        const body = { stage, pfDate, dueDate, lines: toLines(lines) };
        if (!proforma)
          return apiFetch<{ id: string }>('/api/v1/proformas', {
            method: 'POST',
            idempotencyKey,
            body: { projectId, ...body },
          });
        await apiFetch(`/api/v1/proformas/${proforma.id}`, {
          method: 'PATCH',
          body: { ...body, version: proforma.version },
        });
        return { id: proforma.id };
      },
      (r) => onSaved((r as { id: string }).id),
    );

  return (
    <Drawer
      title={proforma ? `Edit ${proforma.number}` : 'New proforma invoice'}
      width={860}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : proforma ? 'Save changes' : 'Create proforma'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {proforma ? null : (
          <Field label="Project" htmlFor="pf-project">
            <select
              id="pf-project"
              className={selectCls}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">Choose a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.name} · {p.clientName}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Stage name" htmlFor="pf-stage-name">
          <Input
            id="pf-stage-name"
            value={stage}
            placeholder="Advance 30%"
            onChange={(e) => setStage(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" htmlFor="pf-date">
            <Input
              id="pf-date"
              type="date"
              value={pfDate}
              onChange={(e) => setPfDate(e.target.value)}
            />
          </Field>
          <Field label="Payment due" htmlFor="pf-due">
            <Input
              id="pf-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </Field>
        </div>
        <LineGrid lines={lines} onChange={setLines} totals={totals} />
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
