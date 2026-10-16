'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { Pill, Row, Table } from '@/components/kit';
import { ApiFailure, apiFetch } from '@/lib/client';
import { istDateTimeSeconds } from '@/lib/format';

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

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function more() {
    const last = rows.at(-1);
    if (!last || loading) return;
    setLoading(true);
    setError(null);
    try {
      const next = await apiFetch<AuditRow[]>(`/api/v1/audit?before=${last.id}&limit=50`);
      setRows((prev) => [...prev, ...next.filter((n) => !prev.some((p) => p.id === n.id))]);
      setDone(next.length < 50);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'Could not load more entries.');
    } finally {
      setLoading(false);
    }
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
              <span className="num text-muted">{istDateTimeSeconds(r.at)}</span>
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
          <Button variant="ghost" onClick={more} disabled={loading}>
            {loading ? 'Loading…' : 'Load more'}
          </Button>
          {error ? (
            <p role="alert" className="mt-2 text-[13px] text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
