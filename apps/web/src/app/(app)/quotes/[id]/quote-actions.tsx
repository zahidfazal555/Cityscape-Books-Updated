'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { addDays, parseRupees, percentOf, todayIn } from '@csd/core';
import type { QuoteDetail } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Chips, Drawer } from '@/components/kit';
import { useAction } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import { rupees, toRupeeInput } from '@/lib/format';
import { QuoteDrawer, type ClientOption } from '../quote-drawer';

interface Rights {
  edit: boolean;
  full: boolean;
  approve: boolean;
  proforma: boolean;
  invoice: boolean;
  projects: boolean;
  viewProject: boolean;
}
type Open = 'edit' | 'accept' | 'proforma' | 'invoice' | null;

/** Actions by status (README §4b). The server re-checks every one. */
export function QuoteActions({
  quote,
  rights,
  clients,
  companyStateCode,
}: {
  quote: QuoteDetail;
  rights: Rights;
  clients: ClientOption[];
  companyStateCode: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Open>(null);
  const { busy, error, run } = useAction();
  // Every action names the version on screen, so an approval covers exactly what was shown.
  const post = (action: string) => () =>
    run(() =>
      apiFetch(`/api/v1/quotations/${quote.id}/${action}`, {
        method: 'POST',
        body: { version: quote.version },
      }),
    );
  const remove = () => {
    if (!window.confirm(`Delete draft ${quote.number}?`)) return;
    void run(
      () => apiFetch(`/api/v1/quotations/${quote.id}`, { method: 'DELETE' }),
      () => router.push('/quotes'),
    );
  };
  const done = () => {
    setOpen(null);
    router.refresh();
  };
  const buttons = actionsFor(quote, rights, {
    post: (a) => void post(a)(),
    open: setOpen,
    remove,
    openProject: () => router.push(`/projects/${quote.projectId}`),
  });
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => window.print()}>
          Print / PDF
        </Button>
        {buttons.map((b) => (
          <Button
            key={b.label}
            variant={b.primary ? 'primary' : 'ghost'}
            onClick={b.onClick}
            disabled={busy}
          >
            {b.label}
          </Button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      {open === 'edit' ? (
        <QuoteDrawer
          quote={quote}
          clients={clients}
          companyStateCode={companyStateCode}
          onClose={() => setOpen(null)}
          onSaved={done}
        />
      ) : null}
      {open === 'accept' ? (
        <AcceptDrawer
          quote={quote}
          canCreate={rights.projects}
          onClose={() => setOpen(null)}
          onDone={done}
        />
      ) : null}
      {open === 'proforma' ? (
        <ProformaFromQuote
          quote={quote}
          onClose={() => setOpen(null)}
          onDone={(id) => router.push(`/proformas/${id}`)}
        />
      ) : null}
      {open === 'invoice' ? (
        <InvoiceFromQuote
          quote={quote}
          onClose={() => setOpen(null)}
          onDone={(id) => router.push(`/invoices/${id}`)}
        />
      ) : null}
    </div>
  );
}

interface ActionButton {
  label: string;
  primary?: boolean;
  onClick: () => void;
}
interface Handlers {
  post: (action: string) => void;
  open: (o: Open) => void;
  remove: () => void;
  openProject: () => void;
}

/** Buttons for the quote's status (README §4b); only what the user's rights allow. */
function actionsFor(q: QuoteDetail, r: Rights, h: Handlers): ActionButton[] {
  if (q.status === 'draft') return draftActions(q, r, h);
  if (q.status === 'accepted') return acceptedActions(q, r, h);
  if (!r.edit) return [];
  const list: ActionButton[] = [
    {
      label: q.status === 'declined' ? 'Revise & resend' : 'Revise',
      onClick: () => h.post('revise'),
    },
  ];
  if (q.status !== 'declined')
    list.push({ label: 'Mark declined', onClick: () => h.post('decline') });
  if (q.status === 'sent')
    list.push({ label: 'Mark accepted', primary: true, onClick: () => h.open('accept') });
  return list;
}

function draftActions(q: QuoteDetail, r: Rights, h: Handlers): ActionButton[] {
  const list: ActionButton[] = [];
  if (r.full && q.revision === 0) list.push({ label: 'Delete', onClick: h.remove });
  if (r.edit) list.push({ label: 'Edit', onClick: () => h.open('edit') });
  if (r.approve && q.discountPct > 0 && !q.discountApproved)
    list.push({
      label: `Approve ${q.discountPct}% discount`,
      onClick: () => h.post('approve-discount'),
    });
  // Sending waits for the owner's approval of a discount (H2); the button would only fail.
  if (r.edit && (q.discountPct === 0 || q.discountApproved))
    list.push({ label: 'Mark as sent', primary: true, onClick: () => h.post('send') });
  return list;
}

function acceptedActions(q: QuoteDetail, r: Rights, h: Handlers): ActionButton[] {
  const list: ActionButton[] = [];
  if (q.projectId && r.viewProject) list.push({ label: 'Open project', onClick: h.openProject });
  if (r.proforma) list.push({ label: 'Create proforma', onClick: () => h.open('proforma') });
  if (r.invoice)
    list.push({ label: 'Create tax invoice', primary: true, onClick: () => h.open('invoice') });
  return list;
}

/** "Accept quotation & create project" (FR-5.5): budget defaults to 75% with live margin. */
function AcceptDrawer({
  quote,
  canCreate,
  onClose,
  onDone,
}: {
  quote: QuoteDetail;
  canCreate: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(quote.title);
  const [site, setSite] = useState(quote.site ?? '');
  const [startDate, setStartDate] = useState(todayIn());
  const [budget, setBudget] = useState(toRupeeInput(percentOf(quote.taxable, 75)));
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  let margin: string | null = null;
  try {
    const b = parseRupees(budget || '0');
    margin = `${(((quote.taxable - b) / quote.taxable) * 100).toFixed(1)}% planned margin`;
  } catch {
    margin = null;
  }
  return (
    <Drawer
      title={`Accept ${quote.number} & create project`}
      width={520}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !canCreate}
            onClick={() =>
              run(
                () =>
                  apiFetch(`/api/v1/quotations/${quote.id}/accept`, {
                    method: 'POST',
                    idempotencyKey,
                    body: {
                      name,
                      siteAddress: site.trim() || null,
                      startDate,
                      costBudget: parseRupees(budget || '0', 'costBudget'),
                    },
                  }),
                onDone,
              )
            }
          >
            {busy ? 'Creating…' : 'Accept & create project'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!canCreate ? (
          <p className="text-[13px] text-danger">You need project edit rights to accept a quote.</p>
        ) : null}
        <Field label="Project name" htmlFor="a-name">
          <Input id="a-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Site address" htmlFor="a-site">
          <Input id="a-site" value={site} onChange={(e) => setSite(e.target.value)} />
        </Field>
        <Field label="Start date" htmlFor="a-start">
          <Input
            id="a-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </Field>
        <p className="text-[13px]">
          Contract value (quoted taxable value):{' '}
          <span className="num font-semibold">{rupees(quote.taxable)}</span>
        </p>
        <Field label="Cost budget (₹)" htmlFor="a-budget" hint={margin ?? undefined}>
          <Input
            id="a-budget"
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </Field>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}

const SHARES = ['30', '40', '50', '100'] as const;

function ProformaFromQuote({
  quote,
  onClose,
  onDone,
}: {
  quote: QuoteDetail;
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const [pct, setPct] = useState<(typeof SHARES)[number]>('30');
  const [stage, setStage] = useState('');
  const [pfDate, setPfDate] = useState(todayIn());
  const [dueDate, setDueDate] = useState(addDays(todayIn(), 7));
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  return (
    <Drawer
      title={`Proforma from ${quote.number}`}
      width={480}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  apiFetch<{ id: string }>(`/api/v1/quotations/${quote.id}/proforma`, {
                    method: 'POST',
                    idempotencyKey,
                    body: {
                      pct: Number(pct),
                      ...(stage.trim() ? { stage: stage.trim() } : {}),
                      pfDate,
                      dueDate,
                    },
                  }),
                (r) => onDone((r as { id: string }).id),
              )
            }
          >
            {busy ? 'Creating…' : 'Create proforma'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-body">Share of the quote</span>
          <Chips
            label="Share of the quote"
            options={SHARES.map((v) => ({ value: v, label: `${v}%` }))}
            value={pct}
            onChange={setPct}
          />
          <p className="text-xs text-muted">
            {rupees(percentOf(quote.taxable, Number(pct)))} before GST
          </p>
        </div>
        <Field
          label="Stage name"
          htmlFor="pf-stage"
          hint={`Blank = "${pct === '100' ? 'Full value' : `Advance ${pct}%`}"`}
        >
          <Input id="pf-stage" value={stage} onChange={(e) => setStage(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" htmlFor="pf-date">
            <Input
              id="pf-date"
              type="date"
              value={pfDate}
              onChange={(e) => setPfDate(e.target.value)}
            />
          </Field>
          <Field label="Payment due" htmlFor="pf-due">
            <Input
              id="pf-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </Field>
        </div>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}

function InvoiceFromQuote({
  quote,
  onClose,
  onDone,
}: {
  quote: QuoteDetail;
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const [invoiceDate, setInvoiceDate] = useState(todayIn());
  const [dueDate, setDueDate] = useState('');
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  return (
    <Drawer
      title={`Tax invoice from ${quote.number}`}
      width={480}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  apiFetch<{ id: string }>(`/api/v1/quotations/${quote.id}/invoice`, {
                    method: 'POST',
                    idempotencyKey,
                    body: { invoiceDate, ...(dueDate ? { dueDate } : {}) },
                  }),
                (r) => onDone((r as { id: string }).id),
              )
            }
          >
            {busy ? 'Issuing…' : 'Issue tax invoice'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">
          Every quote line is copied
          {quote.discountPct > 0
            ? ` with the ${quote.discountPct}% discount applied to its rate`
            : ' at its quoted rate'}
          .
        </p>
        <Field label="Invoice date" htmlFor="qi-date">
          <Input
            id="qi-date"
            type="date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
          />
        </Field>
        <Field label="Due date" htmlFor="qi-due" hint="Blank = the client's payment terms.">
          <Input
            id="qi-due"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </Field>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
