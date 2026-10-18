import {
  AGEING_BUCKETS,
  AGEING_LABEL,
  can,
  formatDate,
  overdueTone,
  type AgeingBucket,
} from '@csd/core';
import { PageHeader, Row, Table } from '@/components/kit';
import { DownloadLink, LinkTabs } from '@/components/accounts/tabs';
import { EmptyState } from '@/components/ui';
import { rupees } from '@/lib/format';
import { getSession } from '@/lib/session';
import { services } from '@/lib/server';

const BUCKET_COLOUR: Record<AgeingBucket, string> = {
  current: '#1e7a4c',
  d1_30: '#c4a20f',
  d31_60: '#c4730f',
  d61_90: '#b4501a',
  d90_plus: '#b42318',
};

const TONE_CLASS = { none: 'text-muted', amber: 'text-warn', red: 'text-danger' } as const;

/** README §11: receivables and payables with ageing. */
export default async function OutstandingPage({
  searchParams,
}: {
  searchParams: Promise<{ side?: string }>;
}) {
  const { actor } = await getSession();
  if (!can(actor, 'outstanding', 'view'))
    return <EmptyState>You do not have access to outstanding.</EmptyState>;
  const side = (await searchParams).side === 'payables' ? 'payables' : 'receivables';
  const data =
    side === 'receivables'
      ? await services().outstanding.receivables(actor)
      : await services().outstanding.payables(actor);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Outstanding"
        subtitle={`As on ${formatDate(data.asOf)}. Tax invoices and posted bills only: proformas and pending entries are not outstanding.`}
        action={<DownloadLink href={`/api/v1/outstanding/${side}/export`}>Export CSV</DownloadLink>}
      />
      <LinkTabs
        value={side}
        items={[
          { value: 'receivables', label: 'Client receivables', href: '/outstanding' },
          { value: 'payables', label: 'Vendor payables', href: '/outstanding?side=payables' },
        ]}
      />
      <section aria-label="Ageing" className="rounded-lg border border-line bg-white p-4">
        <div className="mb-2 flex justify-between text-[13px]">
          <span className="text-muted">Total outstanding</span>
          <span className="num text-[18px] font-semibold">{rupees(data.total)}</span>
        </div>
        <div
          className="flex h-3 overflow-hidden rounded-full bg-track"
          role="img"
          aria-label="Ageing split"
        >
          {AGEING_BUCKETS.map((b) =>
            data.total > 0 && data.buckets[b] > 0 ? (
              <span
                key={b}
                style={{
                  width: `${(data.buckets[b] / data.total) * 100}%`,
                  background: BUCKET_COLOUR[b],
                }}
              />
            ) : null,
          )}
        </div>
        <ul className="mt-2 flex flex-wrap gap-4 text-[12px] text-muted">
          {AGEING_BUCKETS.map((b) => (
            <li key={b} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ background: BUCKET_COLOUR[b] }}
              />
              {AGEING_LABEL[b]} <span className="num text-ink">{rupees(data.buckets[b])}</span>
            </li>
          ))}
        </ul>
      </section>
      {data.rows.length === 0 ? (
        <EmptyState>Nothing outstanding.</EmptyState>
      ) : (
        <Table columns="1.1fr 1.7fr 0.8fr 0.8fr repeat(5, 0.9fr) 0.8fr" minWidth={1200}>
          <Row head>
            <span>Number</span>
            <span>{side === 'receivables' ? 'Client' : 'Vendor'}</span>
            <span>Project</span>
            <span>Due</span>
            {AGEING_BUCKETS.map((b) => (
              <span key={b} className="text-right">
                {AGEING_LABEL[b]}
              </span>
            ))}
            <span className="text-right">Days overdue</span>
          </Row>
          {data.rows.map((r) => (
            <Row key={r.id}>
              <span className="font-mono text-[12px]">{r.number}</span>
              <span className="truncate">{r.partyName}</span>
              <span className="text-muted">{r.projectCode}</span>
              <span className="text-muted">{formatDate(r.dueDate)}</span>
              {AGEING_BUCKETS.map((b) => (
                <span key={b} className="num text-right">
                  {r.bucket === b ? rupees(r.balance) : ''}
                </span>
              ))}
              <span className={`num text-right ${TONE_CLASS[overdueTone(r.daysOverdue)]}`}>
                {r.daysOverdue}
              </span>
            </Row>
          ))}
          <Row>
            <span className="font-semibold">Total</span>
            <span />
            <span />
            <span />
            {AGEING_BUCKETS.map((b) => (
              <span key={b} className="num text-right font-semibold">
                {rupees(data.buckets[b])}
              </span>
            ))}
            <span />
          </Row>
        </Table>
      )}
    </div>
  );
}
