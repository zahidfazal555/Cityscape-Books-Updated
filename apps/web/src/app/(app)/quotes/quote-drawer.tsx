'use client';

import { useState } from 'react';
import { addDays, todayIn } from '@csd/core';
import type { QuoteDetail } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Drawer } from '@/components/kit';
import { LineGrid, blankLine, draftOf, previewTotals, toLines } from '@/components/sales/line-grid';
import { selectCls, textareaCls, useAction } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';

export interface ClientOption {
  id: string;
  name: string;
  stateCode: string;
}

function initial(q: QuoteDetail | null) {
  const today = todayIn();
  return {
    clientId: q?.clientId ?? '',
    title: q?.title ?? '',
    site: q?.site ?? '',
    quoteDate: q?.quoteDate ?? today,
    validTill: q?.validTill ?? addDays(today, 30),
    discount: q ? String(q.discountPct) : '0',
    terms: q?.terms ?? '',
  };
}

/** New / edit quotation (README §4b, 780px drawer) with live GST totals. */
export function QuoteDrawer({
  quote,
  clients,
  companyStateCode,
  onClose,
  onSaved,
}: {
  quote: QuoteDetail | null;
  clients: ClientOption[];
  companyStateCode: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [f, setF] = useState(() => initial(quote));
  const [lines, setLines] = useState(() => (quote ? quote.lines.map(draftOf) : [blankLine()]));
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const discountPct = Number(f.discount || '0');
  const client = clients.find((c) => c.id === f.clientId);
  const totals = previewTotals(lines, {
    placeOfSupply: client?.stateCode ?? null,
    companyStateCode,
    discountPct: Number.isFinite(discountPct) ? discountPct : 0,
  });

  const save = () =>
    run(
      async () => {
        const body = {
          clientId: f.clientId,
          title: f.title,
          site: f.site.trim() || null,
          quoteDate: f.quoteDate,
          validTill: f.validTill,
          discountPct,
          lines: toLines(lines),
          terms: f.terms.trim() || null,
        };
        if (!quote)
          return apiFetch<{ id: string }>('/api/v1/quotations', {
            method: 'POST',
            idempotencyKey,
            body,
          });
        await apiFetch(`/api/v1/quotations/${quote.id}`, {
          method: 'PATCH',
          body: { ...body, version: quote.version },
        });
        return { id: quote.id };
      },
      (r) => onSaved((r as { id: string }).id),
    );

  return (
    <Drawer
      title={quote ? `Edit ${quote.number}` : 'New quotation'}
      width={860}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : quote ? 'Save changes' : 'Save draft'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Client"
          htmlFor="q-client"
          hint="The client's state decides CGST+SGST or IGST."
        >
          <select id="q-client" className={selectCls} value={f.clientId} onChange={set('clientId')}>
            <option value="">Choose a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Proposal title" htmlFor="q-title">
          <Input id="q-title" value={f.title} onChange={set('title')} />
        </Field>
        <Field label="Site" htmlFor="q-site">
          <Input id="q-site" value={f.site} onChange={set('site')} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Quote date" htmlFor="q-date">
            <Input id="q-date" type="date" value={f.quoteDate} onChange={set('quoteDate')} />
          </Field>
          <Field label="Valid till" htmlFor="q-valid">
            <Input id="q-valid" type="date" value={f.validTill} onChange={set('validTill')} />
          </Field>
          <Field
            label="Discount % (0–50)"
            htmlFor="q-discount"
            hint="A discount needs the owner's approval before the quote is sent."
          >
            <Input
              id="q-discount"
              inputMode="decimal"
              value={f.discount}
              onChange={set('discount')}
            />
          </Field>
        </div>
        <LineGrid lines={lines} onChange={setLines} totals={totals} />
        <Field label="Terms" htmlFor="q-terms">
          <textarea id="q-terms" className={textareaCls} value={f.terms} onChange={set('terms')} />
        </Field>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
