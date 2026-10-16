'use client';

import { useState } from 'react';
import { parseRupees, todayIn, type Paise } from '@csd/core';
import type { ReceiptMode } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Chips, Drawer } from '@/components/kit';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import { rupees, toRupeeInput } from '@/lib/format';
import { MODE_LABEL, RECEIPT_MODES, REFERENCE_LABEL } from '@/lib/sales';
import { selectCls, useAction } from './use-action';

/** An open invoice or proforma a receipt can be recorded against. */
export interface ReceiptTarget {
  kind: 'invoice' | 'proforma';
  id: string;
  number: string;
  clientName: string;
  projectCode: string;
  balance: Paise;
}

const keyOf = (t: ReceiptTarget) => `${t.kind}:${t.id}`;

/**
 * Receipt drawer (README §6): pick the open invoice or proforma, then date, amount (with a
 * "Full" shortcut), mode, reference and received by. Against a proforma it is an advance.
 */
export function ReceiptDrawer({
  targets,
  onClose,
  onSaved,
}: {
  targets: ReceiptTarget[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [target, setTarget] = useState(targets.length === 1 && targets[0] ? keyOf(targets[0]) : '');
  const [receiptDate, setReceiptDate] = useState(todayIn());
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<ReceiptMode>('bank');
  const [reference, setReference] = useState('');
  const [receivedBy, setReceivedBy] = useState('');
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const chosen = targets.find((t) => keyOf(t) === target);

  const save = () =>
    run(
      () =>
        apiFetch('/api/v1/receipts', {
          method: 'POST',
          idempotencyKey,
          body: {
            ...(chosen?.kind === 'proforma'
              ? { proformaId: chosen.id }
              : { invoiceId: chosen?.id ?? '' }),
            receiptDate,
            amount: parseRupees(amount || '0', 'amount'),
            mode,
            reference: reference.trim() || null,
            receivedBy: receivedBy.trim() || null,
          },
        }),
      () => onSaved(),
    );

  return (
    <Drawer
      title={chosen?.kind === 'proforma' ? 'Record advance' : 'Record receipt'}
      width={520}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !chosen}>
            {busy ? 'Saving…' : 'Save receipt'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Against"
          htmlFor="r-target"
          hint={
            chosen?.kind === 'proforma'
              ? 'Held as a customer advance until the proforma is converted.'
              : undefined
          }
        >
          <select
            id="r-target"
            className={selectCls}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Choose an open invoice or proforma…</option>
            {targets.map((t) => (
              <option key={keyOf(t)} value={keyOf(t)}>
                {t.number} · {t.clientName} · {t.projectCode} · due {rupees(t.balance)}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" htmlFor="r-date">
            <Input
              id="r-date"
              type="date"
              value={receiptDate}
              onChange={(e) => setReceiptDate(e.target.value)}
            />
          </Field>
          <Field label="Amount (₹)" htmlFor="r-amount">
            <Input
              id="r-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
        </div>
        {chosen ? (
          <button
            type="button"
            onClick={() => setAmount(toRupeeInput(chosen.balance))}
            className="-mt-2 self-end text-[13px] font-medium text-primary"
          >
            Full {rupees(chosen.balance)}
          </button>
        ) : null}
        <Field label="Mode" htmlFor="r-mode">
          <Chips
            label="Mode"
            options={RECEIPT_MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
            value={mode}
            onChange={setMode}
          />
        </Field>
        <Field label={REFERENCE_LABEL[mode]} htmlFor="r-ref">
          <Input id="r-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Received by (optional)" htmlFor="r-by">
          <Input id="r-by" value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} />
        </Field>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
