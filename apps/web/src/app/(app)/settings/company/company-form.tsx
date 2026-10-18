'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { STATE_CODES } from '@csd/core';
import type { Letterhead } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { ApiFailure, apiFetch } from '@/lib/client';

const STATES = Object.entries(STATE_CODES).sort((a, b) => a[1].localeCompare(b[1]));
const selectCls =
  'h-9 w-full rounded-md border border-input bg-white px-2 text-[13.5px] outline-none focus:border-primary';

type Form = { [K in keyof Letterhead]: string };

function initialForm(c: Letterhead): Form {
  return {
    name: c.name,
    legalName: c.legalName ?? '',
    gstin: c.gstin ?? '',
    stateCode: c.stateCode,
    address: c.address ?? '',
    phone: c.phone ?? '',
    email: c.email ?? '',
    bankName: c.bankName ?? '',
    bankAccount: c.bankAccount ?? '',
    bankIfsc: c.bankIfsc ?? '',
    bankBranch: c.bankBranch ?? '',
  };
}

/** Settings → Company: the GSTIN fills the state and must match it (same rule as contacts). */
export function CompanyForm({ current }: { current: Letterhead }) {
  const router = useRouter();
  const [f, setF] = useState(() => initialForm(current));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setSaved(false);
    setF({ ...f, [k]: e.target.value });
  };
  const gstinState = /^\d{2}/.test(f.gstin) ? f.gstin.slice(0, 2) : null;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await apiFetch('/api/v1/settings', {
        method: 'PATCH',
        body: {
          ...f,
          gstin: f.gstin.trim().toUpperCase(),
          bankIfsc: f.bankIfsc.trim().toUpperCase(),
        },
      });
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'Could not save the company details.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Company name" htmlFor="co-name">
          <Input id="co-name" value={f.name} onChange={set('name')} />
        </Field>
        <Field
          label="Legal name (printed on documents)"
          htmlFor="co-legal"
          hint="Leave blank to print the company name."
        >
          <Input id="co-legal" value={f.legalName} onChange={set('legalName')} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="GSTIN" htmlFor="co-gstin">
          <Input
            id="co-gstin"
            value={f.gstin}
            onChange={(e) => {
              setSaved(false);
              const v = e.target.value.toUpperCase();
              const code = /^\d{2}/.test(v) ? v.slice(0, 2) : null;
              setF({ ...f, gstin: v, stateCode: code && code in STATE_CODES ? code : f.stateCode });
            }}
            className="h-9 font-mono"
            maxLength={15}
          />
        </Field>
        <Field
          label="State"
          htmlFor="co-state"
          hint="Decides CGST + SGST or IGST on every document."
        >
          <select
            id="co-state"
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
      <Field label="Address" htmlFor="co-addr" hint="Line breaks are kept on printed documents.">
        <textarea
          id="co-addr"
          rows={4}
          value={f.address}
          onChange={set('address')}
          className="rounded-md border border-input bg-white px-3 py-2 text-[13.5px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary-tint"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Phone" htmlFor="co-phone">
          <Input id="co-phone" inputMode="tel" value={f.phone} onChange={set('phone')} />
        </Field>
        <Field label="Email" htmlFor="co-email">
          <Input id="co-email" type="email" value={f.email} onChange={set('email')} />
        </Field>
      </div>
      <h3 className="mt-2 text-[13.5px] font-semibold">
        Bank details (printed for clients to pay into)
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bank name" htmlFor="co-bank">
          <Input id="co-bank" value={f.bankName} onChange={set('bankName')} />
        </Field>
        <Field label="Account number" htmlFor="co-acc">
          <Input
            id="co-acc"
            inputMode="numeric"
            value={f.bankAccount}
            onChange={set('bankAccount')}
          />
        </Field>
        <Field label="IFSC" htmlFor="co-ifsc">
          <Input
            id="co-ifsc"
            value={f.bankIfsc}
            onChange={set('bankIfsc')}
            className="h-9 font-mono uppercase"
            maxLength={11}
          />
        </Field>
        <Field label="Branch" htmlFor="co-branch">
          <Input id="co-branch" value={f.bankBranch} onChange={set('bankBranch')} />
        </Field>
      </div>
      <FormError message={error} />
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save company details'}
        </Button>
        {saved ? <p className="text-[13px] text-success">Company details saved.</p> : null}
      </div>
    </div>
  );
}
