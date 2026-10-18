'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { parseRupees } from '@csd/core';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Drawer } from '@/components/kit';
import { useAction } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';

/** Statement-match tick: refreshes the counts after saving and says so if it fails (BUG-135). */
export function MatchBox({
  lineId,
  matched,
  disabled,
  label,
}: {
  lineId: string;
  matched: boolean;
  disabled: boolean;
  label: string;
}) {
  const router = useRouter();
  const [on, setOn] = useState(matched);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="checkbox"
        aria-label={label}
        title={disabled ? 'You can view the register but not tick it.' : undefined}
        className="h-5 w-5"
        checked={on}
        disabled={disabled || busy}
        onChange={(e) => {
          const next = e.target.checked;
          setOn(next);
          setBusy(true);
          setFailed(false);
          apiFetch(`/api/v1/banking/lines/${lineId}/match`, {
            method: 'POST',
            body: { matched: next },
          })
            .then(() => router.refresh())
            .catch(() => {
              setOn(matched);
              setFailed(true);
            })
            .finally(() => setBusy(false));
        }}
      />
      {failed ? (
        <span role="alert" className="text-[11px] text-danger">
          Not saved
        </span>
      ) : null}
    </span>
  );
}

/**
 * Owner only: an account's opening balance as on a date (FR-13.1). A blank amount is refused;
 * zero (removing the opening) must be typed and confirmed (BUG-132).
 */
export function OpeningBalance({ code, name }: { code: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [asOf, setAsOf] = useState('');
  const [idempotencyKey, setKey] = useState(newIdempotencyKey);
  const { busy, error, setError, run } = useAction();
  const save = () => {
    if (!amount.trim()) {
      setError('Enter the opening balance (0 removes it).');
      return;
    }
    const paise = parseRupees(amount.trim(), 'amount');
    if (paise === 0 && !window.confirm(`Remove the opening balance of ${name}?`)) return;
    void run(
      () =>
        apiFetch('/api/v1/banking/opening', {
          method: 'POST',
          idempotencyKey,
          body: { code, amount: paise, asOf },
        }),
      () => {
        setOpen(false);
        router.refresh();
      },
    );
  };
  return (
    <>
      <Button
        variant="ghost"
        onClick={() => {
          setKey(newIdempotencyKey());
          setOpen(true);
        }}
      >
        Opening balance
      </Button>
      {open ? (
        <Drawer
          title={`Opening balance · ${name}`}
          width={440}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={save}>
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-muted">
              Enter the balance of <strong>{name}</strong> from the statement at the start date.
              Entering it again replaces the earlier figure. Use a minus sign for an overdraft.
            </p>
            <Field label="Amount (₹)" htmlFor="ob-amount">
              <Input
                id="ob-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="As on" htmlFor="ob-date">
              <Input
                id="ob-date"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
              />
            </Field>
            <FormError message={error} />
          </div>
        </Drawer>
      ) : null}
    </>
  );
}
