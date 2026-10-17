'use client';

import { useState } from 'react';
import { parseRupees } from '@csd/core';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Drawer } from '@/components/kit';
import { useAction } from '@/components/sales/use-action';
import { apiFetch } from '@/lib/client';

/** "-1,500" → −150000 paise (an overdraft); the amount itself is parsed as usual. */
function signedPaise(text: string): number {
  const t = text.trim();
  const negative = t.startsWith('-');
  const p = parseRupees((negative ? t.slice(1) : t) || '0', 'amount');
  return negative ? -p : p;
}

/** Statement-match tick for one register line; it reverts if the save fails. */
export function MatchBox({
  lineId,
  matched,
  disabled,
}: {
  lineId: string;
  matched: boolean;
  disabled: boolean;
}) {
  const [on, setOn] = useState(matched);
  const [busy, setBusy] = useState(false);
  return (
    <input
      type="checkbox"
      aria-label="Matched with statement"
      className="h-5 w-5"
      checked={on}
      disabled={disabled || busy}
      onChange={(e) => {
        const next = e.target.checked;
        setOn(next);
        setBusy(true);
        apiFetch(`/api/v1/banking/lines/${lineId}/match`, {
          method: 'POST',
          body: { matched: next },
        })
          .catch(() => setOn(!next))
          .finally(() => setBusy(false));
      }}
    />
  );
}

/** Owner only: an account's opening balance as on a date (FR-13.1). */
export function OpeningBalance({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [asOf, setAsOf] = useState('');
  const { busy, error, run } = useAction();
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Opening balance
      </Button>
      {open ? (
        <Drawer
          title="Opening balance"
          width={440}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  run(
                    () =>
                      apiFetch('/api/v1/banking/opening', {
                        method: 'POST',
                        body: { code, amount: signedPaise(amount), asOf },
                      }),
                    () => window.location.reload(),
                  )
                }
              >
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-muted">
              Enter the balance from the statement at the start date. Entering it again replaces the
              earlier figure. Use a minus sign for an overdraft.
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
