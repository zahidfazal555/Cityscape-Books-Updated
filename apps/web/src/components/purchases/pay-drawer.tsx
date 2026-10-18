'use client';

import { useState } from 'react';
import { parseRupees, todayIn } from '@csd/core';
import type { BillSummary, ReceiptMode } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Chips, Drawer } from '@/components/kit';
import { useAction } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import { rupees, toRupeeInput } from '@/lib/format';
import { OWNER_APPROVAL_NOTE, PAID_BY } from '@/lib/purchases';
import { MODE_LABEL, RECEIPT_MODES, REFERENCE_LABEL } from '@/lib/sales';

/** Pay a bill (FR-10.3). Non-owners' payments wait for the owner (H2). */
export function PayDrawer({
  bill,
  isOwner,
  onClose,
  onSaved,
}: {
  bill: BillSummary;
  isOwner: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const open = bill.balance - bill.pending;
  const [amount, setAmount] = useState(toRupeeInput(Math.max(0, open)));
  const [tds, setTds] = useState('');
  const [payDate, setPayDate] = useState(todayIn());
  const [mode, setMode] = useState<ReceiptMode>('bank');
  const [reference, setReference] = useState('');
  const [paidBy, setPaidBy] = useState<string>(PAID_BY[0]);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const save = () =>
    run(
      () =>
        apiFetch('/api/v1/vendor-payments', {
          method: 'POST',
          idempotencyKey,
          body: {
            billId: bill.id,
            payDate,
            amount: parseRupees(amount || '0', 'amount'),
            tds: parseRupees(tds || '0', 'tds'),
            mode,
            reference: reference.trim() || null,
            paidBy,
          },
        }),
      () => onSaved(),
    );
  return (
    <Drawer
      title={`Pay ${bill.vendorName} · bill ${bill.billNo}`}
      width={520}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : isOwner ? 'Record payment' : 'Submit for approval'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">
          Balance {rupees(bill.balance)}
          {bill.pending > 0 ? ` · ${rupees(bill.pending)} waiting for approval` : ''}
        </p>
        {isOwner ? null : (
          <p className="rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-[13px] text-warn">
            {OWNER_APPROVAL_NOTE}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (₹)" htmlFor="p-amount" hint="Settled against the bill, before TDS.">
            <Input
              id="p-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="TDS deducted (₹)" htmlFor="p-tds" hint="Optional.">
            <Input
              id="p-tds"
              inputMode="decimal"
              value={tds}
              onChange={(e) => setTds(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Date" htmlFor="p-date">
          <Input
            id="p-date"
            type="date"
            value={payDate}
            onChange={(e) => setPayDate(e.target.value)}
          />
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
        <Field label={REFERENCE_LABEL[mode]} htmlFor="p-ref">
          <Input id="p-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-body">Paid by</span>
          <Chips
            label="Paid by"
            options={PAID_BY.map((p) => ({ value: p, label: p }))}
            value={paidBy}
            onChange={setPaidBy}
          />
        </div>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
