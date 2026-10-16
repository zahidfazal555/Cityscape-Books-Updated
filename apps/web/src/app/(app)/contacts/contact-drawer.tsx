'use client';

import { useState } from 'react';
import { STATE_CODES } from '@csd/core';
import type { Contact, ContactType } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Drawer } from '@/components/kit';
import { ApiFailure, apiFetch, newIdempotencyKey } from '@/lib/client';

const STATES = Object.entries(STATE_CODES).sort((a, b) => a[1].localeCompare(b[1]));
const selectCls =
  'h-9 w-full rounded-md border border-input bg-white px-2 text-[13.5px] outline-none focus:border-primary';

function initialForm(contact: Contact | null) {
  return {
    name: contact?.name ?? '',
    contactPerson: contact?.contactPerson ?? '',
    phone: contact?.phone ?? '',
    email: contact?.email ?? '',
    gstin: contact?.gstin ?? '',
    stateCode: contact?.stateCode ?? '33',
    address: contact?.address ?? '',
  };
}

/** Client/vendor form (README §4a): GSTIN must match the chosen state. */
export function ContactDrawer({
  type,
  contact,
  onClose,
  onSaved,
}: {
  type: ContactType;
  contact: Contact | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState(() => initialForm(contact));
  // One key for as long as the form is open: a double submit cannot create two records.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const gstinState = /^\d{2}/.test(f.gstin) ? f.gstin.slice(0, 2) : null;

  async function save() {
    setBusy(true);
    setError(null);
    const body = { ...f, gstin: f.gstin.trim().toUpperCase() };
    try {
      if (contact) await apiFetch(`/api/v1/contacts/${contact.id}`, { method: 'PATCH', body });
      else
        await apiFetch('/api/v1/contacts', {
          method: 'POST',
          body: { ...body, type },
          idempotencyKey,
        });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'Could not save.');
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={contact ? `Edit ${contact.name}` : `Add ${type}`}
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
        <Field label="Name" htmlFor="c-name">
          <Input id="c-name" value={f.name} onChange={set('name')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact person" htmlFor="c-person">
            <Input id="c-person" value={f.contactPerson} onChange={set('contactPerson')} />
          </Field>
          <Field label="Mobile" htmlFor="c-phone">
            <Input id="c-phone" inputMode="numeric" value={f.phone} onChange={set('phone')} />
          </Field>
        </div>
        <Field label="Email" htmlFor="c-email">
          <Input id="c-email" type="email" value={f.email} onChange={set('email')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="GSTIN (leave blank if unregistered)" htmlFor="c-gstin">
            <Input
              id="c-gstin"
              value={f.gstin}
              onChange={(e) => {
                const v = e.target.value.toUpperCase();
                const code = /^\d{2}/.test(v) ? v.slice(0, 2) : null;
                setF({
                  ...f,
                  gstin: v,
                  stateCode: code && code in STATE_CODES ? code : f.stateCode,
                });
              }}
              className="font-mono"
              maxLength={15}
            />
          </Field>
          <Field
            label="State"
            htmlFor="c-state"
            hint={
              type === 'client'
                ? f.stateCode === '33'
                  ? 'Tamil Nadu: CGST + SGST'
                  : 'Outside Tamil Nadu: IGST'
                : undefined
            }
          >
            <select
              id="c-state"
              className={selectCls}
              value={f.stateCode}
              onChange={set('stateCode')}
            >
              {STATES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name} ({code})
                </option>
              ))}
            </select>
          </Field>
        </div>
        {gstinState && gstinState !== f.stateCode ? (
          <p className="text-[12.5px] text-warn">
            The GSTIN starts with {gstinState}, which does not match the chosen state.
          </p>
        ) : null}
        <Field label="Address" htmlFor="c-addr">
          <Input id="c-addr" value={f.address} onChange={set('address')} />
        </Field>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
