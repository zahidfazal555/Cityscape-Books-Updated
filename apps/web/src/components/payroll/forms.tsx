'use client';

import { useState } from 'react';
import { parseRupees } from '@csd/core';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Chips, Drawer } from '@/components/kit';
import { selectCls, useAction, type ProjectOption } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';

const RATE_NOTE = 'The owner approves the rate before it can be paid.';

function ProjectSelect({
  id,
  projects,
  value,
  onChange,
}: {
  id: string;
  projects: readonly ProjectOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select id={id} className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a project</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.code} · {p.name}
        </option>
      ))}
    </select>
  );
}

function Footer({
  busy,
  onClose,
  onSave,
  label,
}: {
  busy: boolean;
  onClose: () => void;
  onSave: () => void;
  label: string;
}) {
  return (
    <>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button onClick={onSave} disabled={busy}>
        {busy ? 'Saving…' : label}
      </Button>
    </>
  );
}

/** "+ Add employee" / "+ Add worker" (FR-17.4). */
export function EmployeeDrawer({
  kind,
  projects,
  isOwner,
  onClose,
  onSaved,
}: {
  kind: 'salaried' | 'daily';
  projects: readonly ProjectOption[];
  isOwner: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const staff = kind === 'salaried';
  const [name, setName] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const [rate, setRate] = useState('');
  const [tds, setTds] = useState('');
  const [pt, setPt] = useState(staff && isOwner ? '1250' : '');
  const [recovery, setRecovery] = useState('');
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const money = (v: string, f: string) => parseRupees(v.trim() || '0', f);
  const save = () =>
    run(
      () =>
        apiFetch('/api/v1/payroll/employees', {
          method: 'POST',
          idempotencyKey,
          body: {
            kind,
            name,
            roleTitle,
            projectId: projectId || null,
            rate: money(rate, 'rate'),
            // BUG-147 (H2): deductions are the Owner's; others leave them for the Owner to set.
            ...(staff && isOwner
              ? {
                  monthlyTds: money(tds, 'monthlyTds'),
                  ptHalfYear: money(pt, 'ptHalfYear'),
                  recoveryInstalment: money(recovery, 'recoveryInstalment'),
                }
              : {}),
          },
        }),
      () => onSaved(),
    );
  return (
    <Drawer
      title={staff ? 'Add employee' : 'Add worker'}
      onClose={onClose}
      footer={<Footer busy={busy} onClose={onClose} onSave={save} label="Add" />}
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" htmlFor="e-name">
          <Input id="e-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={staff ? 'Designation' : 'Trade'} htmlFor="e-role">
          <Input id="e-role" value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} />
        </Field>
        {staff ? null : (
          <Field label="Project" htmlFor="e-project">
            <ProjectSelect
              id="e-project"
              projects={projects}
              value={projectId}
              onChange={setProjectId}
            />
          </Field>
        )}
        <Field
          label={staff ? 'Monthly gross (₹)' : 'Daily rate (₹)'}
          htmlFor="e-rate"
          hint={isOwner ? undefined : RATE_NOTE}
        >
          <Input
            id="e-rate"
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
        </Field>
        {staff && !isOwner ? (
          <p className="text-xs text-muted">
            The owner sets TDS, professional tax and advance recovery.
          </p>
        ) : null}
        {staff && isOwner ? (
          <div className="grid grid-cols-3 gap-3">
            <Field label="TDS / month (₹)" htmlFor="e-tds">
              <Input
                id="e-tds"
                inputMode="decimal"
                value={tds}
                onChange={(e) => setTds(e.target.value)}
              />
            </Field>
            <Field label="Prof. tax / half-year (₹)" htmlFor="e-pt" hint="Sept and March runs.">
              <Input
                id="e-pt"
                inputMode="decimal"
                value={pt}
                onChange={(e) => setPt(e.target.value)}
              />
            </Field>
            <Field label="Advance recovery / month (₹)" htmlFor="e-rec">
              <Input
                id="e-rec"
                inputMode="decimal"
                value={recovery}
                onChange={(e) => setRecovery(e.target.value)}
              />
            </Field>
          </div>
        ) : null}
        <FormError message={error} />
      </div>
    </Drawer>
  );
}

/** "+ Add contract job" (FR-17.3, TDS u/s 194C). */
export function JobDrawer({
  projects,
  isOwner,
  onClose,
  onSaved,
}: {
  projects: readonly ProjectOption[];
  isOwner: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [contractor, setContractor] = useState('');
  const [work, setWork] = useState('');
  const [projectId, setProjectId] = useState('');
  const [value, setValue] = useState('');
  const [tdsRate, setTdsRate] = useState<'0' | '1' | '2'>('1');
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const save = () =>
    run(
      () =>
        apiFetch('/api/v1/labour/jobs', {
          method: 'POST',
          idempotencyKey,
          body: {
            contractor,
            work,
            projectId,
            value: parseRupees(value.trim() || '0', 'value'),
            tdsRate: Number(tdsRate),
          },
        }),
      () => onSaved(),
    );
  return (
    <Drawer
      title="Add contract job"
      onClose={onClose}
      footer={<Footer busy={busy} onClose={onClose} onSave={save} label="Add" />}
    >
      <div className="flex flex-col gap-4">
        <Field label="Contractor" htmlFor="j-who">
          <Input id="j-who" value={contractor} onChange={(e) => setContractor(e.target.value)} />
        </Field>
        <Field label="Work" htmlFor="j-work">
          <Input id="j-work" value={work} onChange={(e) => setWork(e.target.value)} />
        </Field>
        <Field label="Project" htmlFor="j-project">
          <ProjectSelect
            id="j-project"
            projects={projects}
            value={projectId}
            onChange={setProjectId}
          />
        </Field>
        <Field label="Job value (₹)" htmlFor="j-value" hint={isOwner ? undefined : RATE_NOTE}>
          <Input
            id="j-value"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-body">TDS u/s 194C</span>
          <Chips
            label="TDS u/s 194C"
            options={[
              { value: '1', label: '1% individual / HUF' },
              { value: '2', label: '2% others' },
              { value: '0', label: 'None' },
            ]}
            value={tdsRate}
            onChange={setTdsRate}
          />
        </div>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
