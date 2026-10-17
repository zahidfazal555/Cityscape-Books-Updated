'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  TICKET_CHANNELS,
  TICKET_PRIORITIES,
  TICKET_TYPES,
  coverageFor,
  todayIn,
  type TicketChannel,
  type TicketPriority,
  type TicketType,
} from '@csd/core';
import type { TicketSummary, TicketView } from '@csd/services';
import { Button, EmptyState, Field, FormError, Input } from '@/components/ui';
import { Chips, Drawer, Pill, Row, Table } from '@/components/kit';
import { Cards } from '@/components/sales/filter-chips';
import {
  selectCls,
  textareaCls,
  useAction,
  type ProjectOption,
} from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import {
  COVERAGE_LABEL,
  COVERAGE_TONE,
  PRIORITY_LABEL,
  PRIORITY_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  TYPE_LABEL,
  CHANNEL_LABEL,
  slaText,
} from '@/lib/support';

type Counts = Record<TicketView | 'visits' | 'awaiting', number>;
export interface WarrantyInfo {
  handoverDate: string | null;
  warrantyMonths: number;
  amcUntil: string | null;
}

const VIEW_LABEL: Record<TicketView, string> = {
  open: 'Open',
  mine: 'Assigned to me',
  breached: 'SLA breached',
  unassigned: 'Unassigned',
  resolved: 'Resolved',
  closed: 'Closed',
  all: 'All',
};

/** FR-19.6: cards, view chips with counts, and the queue. */
export function TicketQueue({
  tickets,
  counts,
  view,
  projects,
  handlers,
  warranty,
  canLog,
}: {
  tickets: TicketSummary[];
  counts: Counts;
  view: TicketView;
  projects: ProjectOption[];
  handlers: { id: string; name: string }[];
  warranty: Record<string, WarrantyInfo>;
  canLog: boolean;
}) {
  const router = useRouter();
  const [logging, setLogging] = useState(false);
  const now = new Date();
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Views" className="flex flex-wrap gap-1.5">
          {(Object.keys(VIEW_LABEL) as TicketView[]).map((v) => (
            <Link
              key={v}
              href={`/tickets?view=${v}`}
              aria-current={v === view ? 'page' : undefined}
              className={`rounded-full border px-3 py-1 text-[12.5px] ${
                v === view
                  ? 'border-primary bg-primary-tint text-primary'
                  : 'border-line text-muted'
              }`}
            >
              {VIEW_LABEL[v]} · {counts[v]}
            </Link>
          ))}
        </nav>
        {canLog ? <Button onClick={() => setLogging(true)}>+ Log ticket</Button> : null}
      </div>
      <Cards
        items={[
          ['Open', String(counts.open)],
          ['SLA breached', String(counts.breached)],
          ['Visits scheduled', String(counts.visits)],
          ['Awaiting client', String(counts.awaiting)],
        ]}
      />
      {tickets.length === 0 ? (
        <EmptyState>No tickets in this view.</EmptyState>
      ) : (
        <Table columns="0.8fr 2.2fr 1fr 0.7fr 1fr 1.2fr 1fr" minWidth={1080}>
          <Row head>
            <span>Ticket</span>
            <span>Subject · project</span>
            <span>Type</span>
            <span>Priority</span>
            <span>Status</span>
            <span>SLA</span>
            <span>Assigned to</span>
          </Row>
          {tickets.map((t) => {
            const open = t.status !== 'resolved' && t.status !== 'closed';
            const sla =
              !t.firstResponseAt && open
                ? slaText(t.createdAt, t.respDue, null, now)
                : slaText(t.createdAt, t.resolveDue, t.resolvedAt, now, 'Resolved');
            return (
              <Row key={t.id} onClick={() => router.push(`/tickets/${t.id}`)}>
                <Link href={`/tickets/${t.id}`} className="font-mono text-[12px] text-primary">
                  {t.number}
                </Link>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{t.subject}</span>
                  <span className="block truncate text-xs text-muted">
                    {t.projectCode} · {t.clientName}
                  </span>
                </span>
                <span className="truncate text-muted">{TYPE_LABEL[t.type]}</span>
                <span>
                  <Pill tone={PRIORITY_TONE[t.priority]}>{PRIORITY_LABEL[t.priority]}</Pill>
                </span>
                <span>
                  <Pill tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Pill>
                </span>
                <span className={`text-xs ${TONE_TEXT[sla.tone]}`}>
                  {!t.firstResponseAt && open ? 'No response · ' : ''}
                  {sla.text}
                </span>
                <span className="truncate text-muted">{t.assigneeName ?? 'Unassigned'}</span>
              </Row>
            );
          })}
        </Table>
      )}
      {logging ? (
        <LogTicketDrawer
          projects={projects}
          handlers={handlers}
          warranty={warranty}
          onClose={() => setLogging(false)}
          onSaved={(id) => router.push(`/tickets/${id}`)}
        />
      ) : null}
    </>
  );
}

export const TONE_TEXT = {
  green: 'text-success',
  amber: 'text-warn',
  red: 'text-danger font-medium',
  grey: 'text-muted',
} as const;

/** FR-19.2: the Log ticket drawer, with coverage shown live (FR-19.7). */
function LogTicketDrawer({
  projects,
  handlers,
  warranty,
  onClose,
  onSaved,
}: {
  projects: ProjectOption[];
  handlers: { id: string; name: string }[];
  warranty: Record<string, WarrantyInfo>;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [f, setF] = useState({
    projectId: '',
    type: 'snag' as TicketType,
    subject: '',
    description: '',
    priority: 'normal' as TicketPriority,
    channel: 'phone' as TicketChannel,
    callerName: '',
    callerPhone: '',
    assigneeId: '',
  });
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const w = warranty[f.projectId];
  const coverage = f.projectId && w ? coverageFor(f.type, w, todayIn()) : null;
  const save = () =>
    run(
      () =>
        apiFetch<{ id: string }>('/api/v1/tickets', {
          method: 'POST',
          idempotencyKey,
          body: { ...f, assigneeId: f.assigneeId || null, description: f.description || null },
        }),
      (r) => onSaved((r as { id: string }).id),
    );
  return (
    <Drawer
      title="Log support ticket"
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Log ticket'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Project" htmlFor="t-project">
          <select
            id="t-project"
            className={selectCls}
            value={f.projectId}
            onChange={set('projectId')}
          >
            <option value="">Choose a project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name} · {p.clientName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Type" htmlFor="t-type">
          <select id="t-type" className={selectCls} value={f.type} onChange={set('type')}>
            {TICKET_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        {coverage ? (
          <p className="text-[13px]" role="status">
            Coverage: <Pill tone={COVERAGE_TONE[coverage]}>{COVERAGE_LABEL[coverage]}</Pill>
          </p>
        ) : null}
        <Field label="Subject" htmlFor="t-subject">
          <Input id="t-subject" value={f.subject} onChange={set('subject')} />
        </Field>
        <Field label="Description" htmlFor="t-desc">
          <textarea
            id="t-desc"
            className={textareaCls}
            value={f.description}
            onChange={set('description')}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-body">Priority</span>
          <Chips
            label="Priority"
            options={TICKET_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
            value={f.priority}
            onChange={(v) => setF({ ...f, priority: v })}
          />
        </div>
        <Field label="Received via" htmlFor="t-channel">
          <select id="t-channel" className={selectCls} value={f.channel} onChange={set('channel')}>
            {TICKET_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Caller name" htmlFor="t-caller">
            <Input id="t-caller" value={f.callerName} onChange={set('callerName')} />
          </Field>
          <Field label="Caller phone" htmlFor="t-phone">
            <Input
              id="t-phone"
              inputMode="tel"
              value={f.callerPhone}
              onChange={set('callerPhone')}
            />
          </Field>
        </div>
        <Field label="Assign to" htmlFor="t-assign">
          <select
            id="t-assign"
            className={selectCls}
            value={f.assigneeId}
            onChange={set('assigneeId')}
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
    </Drawer>
  );
}
