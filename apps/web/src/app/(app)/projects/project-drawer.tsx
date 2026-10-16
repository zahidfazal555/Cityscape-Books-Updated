'use client';

import { useState } from 'react';
import { parseRupees, todayIn } from '@csd/core';
import type { Project } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Drawer } from '@/components/kit';
import { ApiFailure, apiFetch } from '@/lib/client';
import { toRupeeInput } from '@/lib/format';

export interface ClientOption {
  id: string;
  name: string;
  stateCode: string;
}
export interface TeamOption {
  id: string;
  name: string;
  role: string;
}

const selectCls =
  'h-9 w-full rounded-md border border-input bg-white px-2 text-[13.5px] text-ink outline-none focus:border-primary';

function initialForm(project: Project | null) {
  return {
    name: project?.name ?? '',
    clientId: project?.clientId ?? '',
    siteAddress: project?.siteAddress ?? '',
    startDate: project?.startDate ?? todayIn(),
    endDate: project?.endDate ?? '',
    contract: project ? toRupeeInput(project.contractValue) : '',
    budget: project ? toRupeeInput(project.costBudget) : '',
    managerId: project?.managerId ?? '',
    engineerId: project?.engineerId ?? '',
  };
}
type Form = ReturnType<typeof initialForm>;

/** "29.7% planned margin", or null while the amounts are not valid yet. */
function plannedMargin(f: Form): string | null {
  try {
    const c = parseRupees(f.contract || '0');
    const b = parseRupees(f.budget || '0');
    return c > 0 ? `${(((c - b) / c) * 100).toFixed(1)}% planned margin` : null;
  } catch {
    return null;
  }
}

function toBody(f: Form) {
  return {
    name: f.name,
    clientId: f.clientId,
    siteAddress: f.siteAddress.trim() || null,
    startDate: f.startDate,
    endDate: f.endDate || null,
    contractValue: parseRupees(f.contract || '0', 'contractValue'),
    costBudget: parseRupees(f.budget || '0', 'costBudget'),
    managerId: f.managerId || null,
    engineerId: f.engineerId || null,
  };
}

/** Project create/edit drawer (560px). Amounts are typed in rupees and sent as exact paise. */
export function ProjectDrawer({
  project,
  clients,
  team,
  onClose,
  onSaved,
}: {
  project: Project | null;
  clients: ClientOption[];
  team: TeamOption[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [f, setF] = useState(() => initialForm(project));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });

  const margin = plannedMargin(f);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = toBody(f);
      if (project) {
        await apiFetch(`/api/v1/projects/${project.id}`, { method: 'PATCH', body });
        onSaved(project.id);
      } else {
        const created = await apiFetch<{ id: string }>('/api/v1/projects', {
          method: 'POST',
          body,
        });
        onSaved(created.id);
      }
    } catch (e) {
      setError(
        e instanceof ApiFailure || e instanceof Error ? e.message : 'Could not save the project.',
      );
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={project ? `Edit ${project.code}` : 'New project'}
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : project ? 'Save changes' : 'Create project'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Project name" htmlFor="p-name">
          <Input id="p-name" value={f.name} onChange={set('name')} />
        </Field>
        <Field
          label="Client"
          htmlFor="p-client"
          hint="The client's state decides CGST+SGST or IGST on invoices."
        >
          <select id="p-client" className={selectCls} value={f.clientId} onChange={set('clientId')}>
            <option value="">Choose a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Site address" htmlFor="p-site">
          <Input id="p-site" value={f.siteAddress} onChange={set('siteAddress')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date" htmlFor="p-start">
            <Input id="p-start" type="date" value={f.startDate} onChange={set('startDate')} />
          </Field>
          <Field label="End date (optional)" htmlFor="p-end">
            <Input id="p-end" type="date" value={f.endDate} onChange={set('endDate')} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contract value (₹, excl. GST)" htmlFor="p-contract">
            <Input
              id="p-contract"
              inputMode="decimal"
              value={f.contract}
              onChange={set('contract')}
              placeholder="10,00,000"
            />
          </Field>
          <Field
            label="Cost budget (₹)"
            htmlFor="p-budget"
            hint={margin ?? 'Alerts at 85% and over 100% of this.'}
          >
            <Input
              id="p-budget"
              inputMode="decimal"
              value={f.budget}
              onChange={set('budget')}
              placeholder="7,50,000"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Project manager" htmlFor="p-pm">
            <select id="p-pm" className={selectCls} value={f.managerId} onChange={set('managerId')}>
              <option value="">—</option>
              {team.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Site engineer" htmlFor="p-eng">
            <select
              id="p-eng"
              className={selectCls}
              value={f.engineerId}
              onChange={set('engineerId')}
            >
              <option value="">—</option>
              {team.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
