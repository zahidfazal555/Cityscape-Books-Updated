'use client';

import { useState } from 'react';
import {
  ALLOWED_LEVELS,
  MODULES,
  roleTemplate,
  type Level,
  type Module,
  type Rights,
  type Role,
} from '@csd/core';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Chips, Drawer, Pill, Segmented } from '@/components/kit';
import { ApiFailure, apiFetch } from '@/lib/client';
import { endOfIstDay } from '@/lib/format';
import { LEVEL_LABEL, MODULE_LABEL, ROLE_LABEL } from '@/lib/labels';
import type { ProjectOption, UserView } from './users-admin';

export type EditableUser = UserView;
type AssignableRole = Exclude<Role, 'owner'>;

const ROLES: { value: AssignableRole; label: string }[] = (
  ['admin', 'manager', 'asstmgr', 'site', 'auditor'] as const
).map((r) => ({
  value: r,
  label: ROLE_LABEL[r],
}));

function initialUser(user: EditableUser | null) {
  return {
    name: user?.name ?? '',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
    role: (user?.role as AssignableRole | undefined) ?? 'manager',
    rights: user?.rights ?? roleTemplate('manager'),
    projectsAll: user?.projectsAll ?? true,
    projectIds: user?.projectIds ?? [],
    expires: user?.accessExpiresAt ?? '',
  };
}

/** Levels a module allows; an auditor is never offered edit or full. */
function levelOptions(m: Module, role: AssignableRole) {
  return ALLOWED_LEVELS[m]
    .filter((l) => role !== 'auditor' || l === 'none' || l === 'view')
    .map((l) => ({ value: l, label: LEVEL_LABEL[l] }));
}

/** User drawer (660px, README §16): details, role, project scope, rights per module. */
export function UserDrawer({
  user,
  projects,
  onClose,
  onSaved,
}: {
  user: EditableUser | null;
  projects: ProjectOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const init = initialUser(user);
  const [name, setName] = useState(init.name);
  const [email, setEmail] = useState(init.email);
  const [phone, setPhone] = useState(init.phone);
  const [role, setRole] = useState<AssignableRole>(init.role);
  const [rights, setRights] = useState<Rights>(init.rights);
  const [projectsAll, setProjectsAll] = useState(init.projectsAll);
  const [projectIds, setProjectIds] = useState<string[]>(init.projectIds);
  const [expires, setExpires] = useState(init.expires);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const template = roleTemplate(role);
  const custom = MODULES.some((m) => template[m] !== rights[m]);

  function changeRole(next: AssignableRole) {
    setRole(next);
    setRights(roleTemplate(next)); // README: changing the role resets rights to that role's template
  }

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      name,
      email,
      phone: phone.trim() === '' ? null : phone.trim(),
      role,
      projectsAll,
      projectIds: projectsAll ? [] : projectIds,
      permissions: rights,
      accessExpiresAt: role === 'auditor' && expires ? endOfIstDay(expires) : null,
    };
    try {
      if (user) await apiFetch(`/api/v1/users/${user.id}`, { method: 'PATCH', body });
      else await apiFetch('/api/v1/users', { method: 'POST', body });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'Could not save. Try again.');
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={user ? `Edit ${user.name}` : 'Add user'}
      width={660}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : user ? 'Save changes' : 'Add user & send invite'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name or role title" htmlFor="u-name">
          <Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Work email" htmlFor="u-email" hint="The invite link is sent here.">
            <Input
              id="u-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Mobile (contact only)" htmlFor="u-phone">
            <Input
              id="u-phone"
              inputMode="numeric"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-body">Role</span>
          <Chips label="Role" options={ROLES} value={role} onChange={changeRole} />
        </div>
        {role === 'auditor' ? (
          <Field label="Access ends on" htmlFor="u-exp" hint="Auditor access always expires.">
            <Input
              id="u-exp"
              type="date"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </Field>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-body">Project access</span>
          <Chips
            label="Project access"
            options={[
              { value: 'all', label: 'All projects' },
              { value: 'some', label: 'Selected projects only' },
            ]}
            value={projectsAll ? 'all' : 'some'}
            onChange={(v) => setProjectsAll(v === 'all')}
          />
          {!projectsAll ? (
            <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="Projects">
              {projects.map((p) => {
                const on = projectIds.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setProjectIds(
                        on ? projectIds.filter((x) => x !== p.id) : [...projectIds, p.id],
                      )
                    }
                    className={`h-[30px] rounded-[15px] border px-3 text-[12.5px] ${on ? 'border-primary bg-primary-tint text-primary' : 'border-input text-body'}`}
                  >
                    <span className="font-mono text-[11px]">{p.code}</span> {p.name}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[13px] font-medium text-body">Rights by module</span>
            {custom ? <Pill tone="amber">Custom</Pill> : null}
            {custom ? (
              <button
                type="button"
                className="ml-auto text-[12.5px] text-primary hover:underline"
                onClick={() => setRights(template)}
              >
                Reset to role defaults
              </button>
            ) : null}
          </div>
          <div className="divide-y divide-divider rounded-lg border border-line">
            {MODULES.map((m: Module) => (
              <div key={m} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="text-[13px]">{MODULE_LABEL[m]}</span>
                <Segmented<Level>
                  label={MODULE_LABEL[m]}
                  options={levelOptions(m, role)}
                  value={rights[m]}
                  onChange={(level) => setRights({ ...rights, [m]: level })}
                />
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            Users &amp; security is owner-only and cannot be granted.
          </p>
        </div>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
