'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { Pill, Row, Table } from '@/components/kit';
import { apiFetch } from '@/lib/client';

export interface AuditRow {
  id: number;
  at: string;
  userName: string | null;
  ip: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  outcome: 'success' | 'denied' | 'failed';
  before: unknown;
  after: unknown;
}

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));

/** Fields that changed between before and after, for a one-line summary. */
function changed(before: unknown, after: unknown): string {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return '';
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return keys.length ? `Changed: ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? '…' : ''}` : '';
}

/** Audit trail, newest first, "Load more" by keyset (Req §16). */
export function AuditTable({ initial }: { initial: AuditRow[] }) {
  const [rows, setRows] = useState(initial);
  const [done, setDone] = useState(initial.length < 50);
  const [open, setOpen] = useState<number | null>(null);

  async function more() {
    const last = rows.at(-1);
    if (!last) return;
    const next = await apiFetch<AuditRow[]>(`/api/v1/audit?before=${last.id}&limit=50`);
    setRows([...rows, ...next]);
    setDone(next.length < 50);
  }

  return (
    <>
      <Table columns="1.4fr 1.2fr 1fr 1.6fr 2.4fr 0.8fr" minWidth={980}>
        <Row head>
          <span>When</span>
          <span>Who</span>
          <span>Action</span>
          <span>Record</span>
          <span>Details</span>
          <span>Result</span>
        </Row>
        {rows.map((r) => (
          <div key={r.id}>
            <Row onClick={() => setOpen(open === r.id ? null : r.id)}>
              <span className="num text-muted">{when(r.at)}</span>
              <span>
                {r.userName ?? '—'}
                {r.ip ? <span className="block text-xs text-subtle">{r.ip}</span> : null}
              </span>
              <span>{r.action.replaceAll('_', ' ')}</span>
              <span className="min-w-0 truncate">
                {r.entity}{' '}
                <span className="font-mono text-[11.5px] text-muted">
                  {r.entityId?.slice(0, 8) ?? ''}
                </span>
              </span>
              <span className="truncate text-muted">{changed(r.before, r.after)}</span>
              <span>
                <Pill
                  tone={
                    r.outcome === 'success' ? 'green' : r.outcome === 'denied' ? 'red' : 'amber'
                  }
                >
                  {r.outcome}
                </Pill>
              </span>
            </Row>
            {open === r.id ? (
              <pre className="overflow-x-auto border-b border-divider bg-thead px-4 py-3 font-mono text-[11.5px] text-body">
                {JSON.stringify({ before: r.before, after: r.after }, null, 2)}
              </pre>
            ) : null}
          </div>
        ))}
      </Table>
      {!done ? (
        <div className="mt-3">
          <Button variant="ghost" onClick={more}>
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
