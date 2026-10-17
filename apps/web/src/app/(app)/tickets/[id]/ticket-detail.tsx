'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  canMoveTicket,
  fillTemplate,
  formatDate,
  todayIn,
  warrantyStatus,
  type TicketStatus,
} from '@csd/core';
import type {
  KbArticle,
  ReplyTemplate,
  SiteVisit,
  TicketBilling,
  TicketDetail,
} from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Chips, Drawer, Pill } from '@/components/kit';
import { selectCls, textareaCls, useAction } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import { istDateTime, rupees } from '@/lib/format';
import {
  CHANNEL_LABEL,
  COVERAGE_LABEL,
  COVERAGE_TONE,
  PRIORITY_LABEL,
  SLOT_LABEL,
  STATUS_LABEL,
  TYPE_LABEL,
  WARRANTY_LABEL,
  slaText,
} from '@/lib/support';
import { TONE_TEXT } from '../ticket-queue';
import { VisitPill } from '../visits-table';

type Kind = 'reply' | 'call' | 'note';
/** Server limit on a thread entry (tickets.ts eventSchema). */
const MAX_EVENT = 4000;
const KIND_LABEL: Record<Kind, string> = {
  reply: 'Reply to client',
  call: 'Call log',
  note: 'Internal note',
};
const EVENT_STYLE = {
  system: 'border-line bg-thead text-muted',
  reply: 'border-line bg-white',
  call: 'border-line bg-white',
  note: 'border-warn-line bg-warn-bg',
} as const;

export interface DocCandidate {
  kind: 'quotation' | 'invoice';
  id: string;
  label: string;
}

const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="rounded-lg border border-line bg-white p-4 text-[13px]">
    <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[.04em] text-muted">
      {title}
    </h3>
    {children}
  </section>
);

/** README §18 ticket detail: main column (issue, thread, composer) + 320px side column. */
export function TicketDetailView({
  ticket: t,
  visits,
  billing,
  handlers,
  engineers,
  templates,
  guides,
  candidates,
  rights,
  now,
}: {
  /** Server time, so the SLA text renders the same on the server and the client (BUG-171). */
  now: string;
  ticket: TicketDetail;
  visits: SiteVisit[];
  billing: TicketBilling;
  handlers: { id: string; name: string }[];
  engineers: { id: string; name: string }[];
  templates: ReplyTemplate[];
  guides: KbArticle[];
  candidates: DocCandidate[];
  rights: { edit: boolean; quotes: boolean; invoices: boolean };
}) {
  const engineer = visits.find((v) => v.status === 'scheduled')?.engineerName ?? '';
  const values = {
    client: t.callerName ?? t.clientName,
    ticket: t.number,
    project: `${t.projectCode} · ${t.projectName}`,
    engineer,
  };
  // {date} is the visit date; with no visit scheduled it stays as typed (BUG-172).
  const visitDate = visits.find((v) => v.status === 'scheduled')?.visitDate;
  if (visitDate) Object.assign(values, { date: formatDate(visitDate) });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        <header>
          <div className="font-mono text-[12px] text-muted">
            {t.number} · {TYPE_LABEL[t.type]} · {CHANNEL_LABEL[t.channel]}
          </div>
          <h1 className="text-[20px] font-semibold">{t.subject}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px]">
            <Pill tone={COVERAGE_TONE[t.coverage]}>{COVERAGE_LABEL[t.coverage]}</Pill>
            <span className="text-muted">Logged {istDateTime(t.createdAt)}</span>
          </div>
          {t.description ? (
            <p className="mt-3 whitespace-pre-wrap text-[14px]">{t.description}</p>
          ) : null}
        </header>
        <ol aria-label="Activity" className="flex flex-col gap-2">
          {t.events.map((e) => (
            <li
              key={e.id}
              className={`rounded-lg border px-3 py-2 text-[13px] ${EVENT_STYLE[e.kind]}`}
            >
              <div className="mb-0.5 text-xs text-muted">
                {e.kind === 'system' ? 'System' : KIND_LABEL[e.kind]} · {e.authorName ?? '—'} ·{' '}
                {istDateTime(e.createdAt)}
              </div>
              <div className="whitespace-pre-wrap">{e.body}</div>
            </li>
          ))}
        </ol>
        {rights.edit ? (
          <Composer ticketId={t.id} templates={templates} guides={guides} values={values} />
        ) : null}
      </div>
      <aside className="flex flex-col gap-3">
        <Properties t={t} handlers={handlers} edit={rights.edit} />
        <SlaCard t={t} now={now} />
        <Card title="Client & site">
          <div className="font-medium">{t.clientName}</div>
          <div className="text-muted">
            {t.projectCode} · {t.projectName}
          </div>
          {t.siteAddress ? <div className="mt-1 text-muted">{t.siteAddress}</div> : null}
          {t.callerName || t.callerPhone ? (
            <div className="mt-2">
              {t.callerName}
              {t.callerPhone ? (
                <a href={`tel:${t.callerPhone}`} className="ml-2 text-primary">
                  {t.callerPhone}
                </a>
              ) : null}
            </div>
          ) : null}
          <WarrantyLine t={t} />
        </Card>
        <Visits t={t} visits={visits} engineers={engineers} edit={rights.edit} />
        <Billing t={t} billing={billing} candidates={candidates} rights={rights} />
        <Rating key={`${t.status}:${t.rating ?? ''}`} t={t} edit={rights.edit} />
      </aside>
    </div>
  );
}

function WarrantyLine({ t }: { t: TicketDetail }) {
  const w = warrantyStatus(t.handoverDate, t.warrantyMonths, todayIn());
  return (
    <div className="mt-2 text-xs text-muted">
      {WARRANTY_LABEL[w.status]}
      {w.end ? ` · ends ${formatDate(w.end)}` : ''}
      {t.amcUntil ? ` · AMC till ${formatDate(t.amcUntil)}` : ''}
    </div>
  );
}

function Composer({
  ticketId,
  templates,
  guides,
  values,
}: {
  ticketId: string;
  templates: ReplyTemplate[];
  guides: KbArticle[];
  values: Record<string, string>;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>('reply');
  const [body, setBody] = useState('');
  const { busy, error, run } = useAction();
  const insert = (text: string) => setBody((b) => (b ? `${b}\n\n${text}` : text));
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line bg-white p-3">
      <Chips
        label="Entry type"
        options={(Object.keys(KIND_LABEL) as Kind[]).map((k) => ({
          value: k,
          label: KIND_LABEL[k],
        }))}
        value={kind}
        onChange={setKind}
      />
      <div className="flex flex-wrap gap-2">
        {templates.length > 0 ? (
          <select
            aria-label="Insert template"
            className={`${selectCls} w-auto`}
            value=""
            onChange={(e) => {
              const tpl = templates.find((x) => x.id === e.target.value);
              if (tpl) insert(fillTemplate(tpl.body, values));
            }}
          >
            <option value="">Insert template…</option>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
              </option>
            ))}
          </select>
        ) : null}
        {guides.length > 0 ? (
          <select
            aria-label="Insert care guide"
            className={`${selectCls} w-auto`}
            value=""
            onChange={(e) => {
              const g = guides.find((x) => x.id === e.target.value);
              if (g) insert(`${g.title}\n${g.body}`);
            }}
          >
            <option value="">Insert care guide…</option>
            {guides.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <label htmlFor="composer" className="sr-only">
        Message
      </label>
      <textarea
        id="composer"
        className={textareaCls}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={kind === 'note' ? 'Only staff see internal notes.' : 'What was said'}
      />
      {body.length > MAX_EVENT ? (
        <p className="text-xs text-danger">
          {body.length.toLocaleString('en-IN')} / {MAX_EVENT.toLocaleString('en-IN')} characters:
          shorten it, or send the guide separately.
        </p>
      ) : null}
      <FormError message={error} />
      <div className="flex justify-end">
        <Button
          disabled={busy || !body.trim() || body.length > MAX_EVENT}
          onClick={() =>
            void run(
              () =>
                apiFetch(`/api/v1/tickets/${ticketId}/events`, {
                  method: 'POST',
                  body: { kind, body },
                }),
              () => {
                setBody('');
                router.refresh();
              },
            )
          }
        >
          Post {KIND_LABEL[kind].toLowerCase()}
        </Button>
      </div>
    </section>
  );
}

function Properties({
  t,
  handlers,
  edit,
}: {
  t: TicketDetail;
  handlers: { id: string; name: string }[];
  edit: boolean;
}) {
  const { busy, error, run } = useAction();
  const patch = (body: Record<string, unknown>) =>
    void run(() => apiFetch(`/api/v1/tickets/${t.id}`, { method: 'PATCH', body }));
  // BUG-165: offer only the moves the server allows; "Visit scheduled" is left by completing or
  // cancelling the visit.
  const statuses = TICKET_STATUSES.filter((s) => s === t.status || canMoveTicket(t.status, s));
  const locked = t.status === 'visit_scheduled';
  return (
    <Card title="Properties">
      <div className="flex flex-col gap-2">
        <Field label="Status" htmlFor="p-status">
          <select
            id="p-status"
            className={selectCls}
            disabled={!edit || busy || locked}
            value={t.status}
            onChange={(e) => patch({ status: e.target.value as TicketStatus })}
          >
            {statuses.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          {locked ? (
            <span className="text-xs text-muted">Complete or cancel the visit to change it.</span>
          ) : null}
        </Field>
        <Field label="Priority" htmlFor="p-priority">
          <select
            id="p-priority"
            className={selectCls}
            disabled={!edit || busy}
            value={t.priority}
            onChange={(e) => patch({ priority: e.target.value })}
          >
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Assigned to" htmlFor="p-assignee">
          <select
            id="p-assignee"
            className={selectCls}
            disabled={!edit || busy}
            value={t.assigneeId ?? ''}
            onChange={(e) => patch({ assigneeId: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            {handlers.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </Field>
        <FormError message={error} />
      </div>
    </Card>
  );
}

function SlaCard({ t, now: nowIso }: { t: TicketDetail; now: string }) {
  const now = new Date(nowIso);
  const resp = slaText(t.createdAt, t.respDue, t.firstResponseAt, now);
  const res = slaText(t.createdAt, t.resolveDue, t.resolvedAt, now, 'Resolved');
  return (
    <Card title="SLA">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted">First response</dt>
        <dd className={TONE_TEXT[resp.tone]}>{resp.text}</dd>
        <dt className="text-muted">Resolution</dt>
        <dd className={TONE_TEXT[res.tone]}>{res.text}</dd>
      </dl>
    </Card>
  );
}

function Visits({
  t,
  visits,
  engineers,
  edit,
}: {
  t: TicketDetail;
  visits: SiteVisit[];
  engineers: { id: string; name: string }[];
  edit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cancel = useAction();
  const done = t.status === 'resolved' || t.status === 'closed';
  return (
    <Card title="Site visits">
      {visits.length === 0 ? <p className="text-muted">None yet.</p> : null}
      <ul className="flex flex-col gap-2">
        {visits.map((v) => (
          <li key={v.id} className="rounded-md border border-line p-2">
            <div className="flex items-center justify-between gap-2">
              <span>
                {formatDate(v.visitDate)} · {SLOT_LABEL[v.slot]}
              </span>
              <VisitPill status={v.status} />
            </div>
            <div className="text-xs text-muted">{v.engineerName}</div>
            {v.workDone ? <div className="mt-1 text-xs">Work done: {v.workDone}</div> : null}
            {v.cost ? <div className="text-xs">Cost {rupees(v.cost)}</div> : null}
            {edit && v.status === 'scheduled' ? (
              <button
                type="button"
                className="mt-1 text-xs text-danger"
                disabled={cancel.busy}
                onClick={() =>
                  window.confirm('Cancel this visit?') &&
                  void cancel.run(() =>
                    apiFetch(`/api/v1/visits/${v.id}/cancel`, { method: 'POST' }),
                  )
                }
              >
                Cancel visit
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <FormError message={cancel.error} />
      {edit && !done ? (
        <Button variant="ghost" className="mt-2 w-full" onClick={() => setOpen(true)}>
          Schedule visit
        </Button>
      ) : null}
      {open ? (
        <ScheduleDrawer ticketId={t.id} engineers={engineers} onClose={() => setOpen(false)} />
      ) : null}
    </Card>
  );
}

function ScheduleDrawer({
  ticketId,
  engineers,
  onClose,
}: {
  ticketId: string;
  engineers: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [visitDate, setDate] = useState(todayIn());
  const [slot, setSlot] = useState<keyof typeof SLOT_LABEL>('morning');
  const [engineerId, setEngineer] = useState(engineers[0]?.id ?? '');
  const [instructions, setInstructions] = useState('');
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const save = () =>
    run(
      () =>
        apiFetch(`/api/v1/tickets/${ticketId}/visits`, {
          method: 'POST',
          idempotencyKey,
          body: { visitDate, slot, engineerId, instructions: instructions || null },
        }),
      () => {
        onClose();
        router.refresh();
      },
    );
  return (
    <Drawer
      title="Schedule site visit"
      width={440}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Schedule'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Date" htmlFor="v-date">
          <Input
            id="v-date"
            type="date"
            value={visitDate}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-body">Slot</span>
          <Chips
            label="Slot"
            options={(Object.keys(SLOT_LABEL) as (keyof typeof SLOT_LABEL)[]).map((s) => ({
              value: s,
              label: SLOT_LABEL[s],
            }))}
            value={slot}
            onChange={setSlot}
          />
        </div>
        <Field label="Site engineer" htmlFor="v-eng">
          <select
            id="v-eng"
            className={selectCls}
            value={engineerId}
            onChange={(e) => setEngineer(e.target.value)}
          >
            {engineers.length === 0 ? <option value="">No active site engineers</option> : null}
            {engineers.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Instructions" htmlFor="v-notes">
          <textarea
            id="v-notes"
            className={textareaCls}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </Field>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}

function Billing({
  t,
  billing,
  candidates,
  rights,
}: {
  t: TicketDetail;
  billing: TicketBilling;
  candidates: DocCandidate[];
  rights: { edit: boolean; quotes: boolean; invoices: boolean };
}) {
  const { busy, error, run } = useAction();
  const [pick, setPick] = useState('');
  const doc = candidates.find((c) => c.id === pick);
  return (
    <Card title="Billing">
      <label className="flex min-h-[32px] items-center gap-2">
        <input
          type="checkbox"
          checked={t.chargeable}
          disabled={!rights.edit || busy}
          onChange={(e) =>
            void run(() =>
              apiFetch(`/api/v1/tickets/${t.id}`, {
                method: 'PATCH',
                body: { chargeable: e.target.checked },
              }),
            )
          }
        />
        Chargeable
      </label>
      {t.chargeable ? (
        <div className="my-2 flex flex-wrap gap-3 text-xs">
          {rights.edit && rights.quotes ? (
            <Link href="/quotes" className="text-primary">
              Create quotation →
            </Link>
          ) : null}
          {rights.edit && rights.invoices ? (
            <Link href="/invoices" className="text-primary">
              Raise tax invoice →
            </Link>
          ) : null}
        </div>
      ) : null}
      <ul className="flex flex-col gap-1">
        {billing.documents.map((d) => (
          <li key={d.id} className="flex justify-between gap-2">
            <Link
              href={`/${d.kind === 'quotation' ? 'quotes' : 'invoices'}/${d.id}`}
              className="font-mono text-[12px] text-primary"
            >
              {d.number}
            </Link>
            <span className="num">{rupees(d.total)}</span>
          </li>
        ))}
        {billing.costs.map((x) => (
          <li key={x.id} className="flex justify-between gap-2 text-muted">
            <span className="truncate">Cost · {x.status}</span>
            <span className="num">{rupees(x.amount)}</span>
          </li>
        ))}
      </ul>
      {rights.edit && candidates.length > 0 ? (
        <div className="mt-2 flex gap-2">
          <select
            aria-label="Link a document"
            className={selectCls}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
          >
            <option value="">Link a quotation or invoice…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.kind === 'quotation' ? 'Quote' : 'Invoice'} {c.label}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            disabled={!doc || busy}
            onClick={() =>
              doc &&
              void run(() =>
                apiFetch(`/api/v1/tickets/${t.id}/billing`, {
                  method: 'POST',
                  body: { kind: doc.kind, id: doc.id },
                }),
              )
            }
          >
            Link
          </Button>
        </div>
      ) : null}
      <FormError message={error} />
    </Card>
  );
}

function Rating({ t, edit }: { t: TicketDetail; edit: boolean }) {
  const [stars, setStars] = useState(t.rating ?? 0);
  const [comment, setComment] = useState(t.ratingComment ?? '');
  const { busy, error, run } = useAction();
  const done = t.status === 'resolved' || t.status === 'closed';
  if (!done && t.rating === null) return null;
  return (
    <Card title="Customer rating">
      <div role="radiogroup" aria-label="Rating" className="flex gap-1 text-[20px]">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={stars === n}
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
            disabled={!edit}
            onClick={() => setStars(n)}
            className={n <= stars ? 'text-warn' : 'text-line'}
          >
            ★
          </button>
        ))}
      </div>
      {edit ? (
        <>
          <label htmlFor="r-comment" className="sr-only">
            Comment
          </label>
          <textarea
            id="r-comment"
            className={`${textareaCls} mt-2`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What the client said on the closing call"
          />
          <Button
            className="mt-2"
            disabled={busy || stars === 0}
            onClick={() =>
              void run(() =>
                apiFetch(`/api/v1/tickets/${t.id}/rating`, {
                  method: 'POST',
                  body: { rating: stars, comment: comment || null },
                }),
              )
            }
          >
            Save rating
          </Button>
        </>
      ) : (
        <p className="mt-1 text-muted">{t.ratingComment}</p>
      )}
      <FormError message={error} />
    </Card>
  );
}
