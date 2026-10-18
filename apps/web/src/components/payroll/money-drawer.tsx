'use client';

import { useState, type ReactNode } from 'react';
import { parseRupees, todayIn } from '@csd/core';
import type { ReceiptMode } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Chips, Drawer } from '@/components/kit';
import { useAction } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import { toRupeeInput } from '@/lib/format';
import { OWNER_APPROVAL_NOTE } from '@/lib/purchases';
import { MODE_LABEL, RECEIPT_MODES, REFERENCE_LABEL } from '@/lib/sales';

/**
 * Money leaving the business from the payroll screens: wages, contractor payments, salary
 * advances and payroll runs. A non-owner's entry waits for the Owner (H2).
 */
export function MoneyDrawer({
  title,
  url,
  body,
  isOwner,
  amount: initial,
  amountLabel = 'Amount (₹)',
  amountHint,
  dateLabel = 'Date',
  summary,
  children,
  onClose,
  onSaved,
}: {
  title: string;
  url: string;
  /** The entry's own fields; amount, date, mode and reference are added. */
  body: (f: {
    amount: number | null;
    date: string;
    mode: ReceiptMode;
    reference: string | null;
  }) => Record<string, unknown>;
  isOwner: boolean;
  /** Pre-filled amount in paise; null hides the amount field (payroll runs). */
  amount: number | null;
  amountLabel?: string;
  amountHint?: string;
  dateLabel?: string;
  summary?: ReactNode;
  children?: ReactNode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState(initial === null ? '' : toRupeeInput(Math.max(0, initial)));
  const [date, setDate] = useState(todayIn());
  const [mode, setMode] = useState<ReceiptMode>('bank');
  const [reference, setReference] = useState('');
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const save = () =>
    run(
      () =>
        apiFetch(url, {
          method: 'POST',
          idempotencyKey,
          body: body({
            amount: initial === null ? null : parseRupees(amount || '0', 'amount'),
            date,
            mode,
            reference: reference.trim() || null,
          }),
        }),
      () => onSaved(),
    );
  return (
    <Drawer
      title={title}
      width={520}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : isOwner ? 'Save' : 'Submit for approval'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {summary ? <div className="text-[13px] text-muted">{summary}</div> : null}
        {isOwner ? null : (
          <p className="rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-[13px] text-warn">
            {OWNER_APPROVAL_NOTE}
          </p>
        )}
        {children}
        {initial === null ? null : (
          <Field label={amountLabel} htmlFor="m-amount" hint={amountHint}>
            <Input
              id="m-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
        )}
        <Field label={dateLabel} htmlFor="m-date">
          <Input id="m-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-body">Mode</span>
          <Chips
            label="Mode"
            options={RECEIPT_MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
            value={mode}
            onChange={setMode}
          />
        </div>
        {mode === 'cash' ? null : (
          <Field label={REFERENCE_LABEL[mode]} htmlFor="m-ref">
            <Input id="m-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        )}
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
