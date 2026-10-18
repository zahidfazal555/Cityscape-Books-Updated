'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDate } from '@csd/core';
import type { QuoteSummary } from '@csd/services';
import { Button, EmptyState } from '@/components/ui';
import { PageHeader, Pill, Row, Table } from '@/components/kit';
import { Cards, FilterChips } from '@/components/sales/filter-chips';
import { rupees } from '@/lib/format';
import { QUOTE_STATUS } from '@/lib/sales';
import { QuoteDrawer, type ClientOption } from './quote-drawer';

const FILTERS = [
  ['all', 'All'],
  ['draft', 'Draft'],
  ['sent', 'Sent'],
  ['accepted', 'Accepted'],
  ['declined', 'Declined'],
  ['expired', 'Expired'],
] as const;

/** Win rate = accepted ÷ (accepted + declined + expired) (FR-5.1). */
function winRate(quotes: QuoteSummary[]): string {
  const n = (s: string) => quotes.filter((q) => q.status === s).length;
  const decided = n('accepted') + n('declined') + n('expired');
  return decided === 0 ? '—' : `${Math.round((n('accepted') / decided) * 100)}%`;
}

export function QuotesView({
  quotes,
  all,
  filter,
  canEdit,
  clients,
  companyStateCode,
}: {
  quotes: QuoteSummary[];
  all: QuoteSummary[];
  filter: string;
  canEdit: boolean;
  clients: ClientOption[];
  companyStateCode: string;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const open = all.filter((q) => q.status === 'draft' || q.status === 'sent');
  const accepted = all.filter((q) => q.status === 'accepted');
  return (
    <>
      <PageHeader
        title="Quotations"
        subtitle="Proposals QT/FY/####, with revisions."
        action={canEdit ? <Button onClick={() => setAdding(true)}>+ New quotation</Button> : null}
      />
      <Cards
        items={[
          ['Open quotes', `${open.length} · ${rupees(open.reduce((s, q) => s + q.total, 0))}`],
          ['Accepted', `${accepted.length} · ${rupees(accepted.reduce((s, q) => s + q.total, 0))}`],
          ['Win rate', winRate(all)],
        ]}
      />
      <FilterChips base="/quotes" options={FILTERS} value={filter} />
      {quotes.length === 0 ? (
        <EmptyState>No quotations here yet.</EmptyState>
      ) : (
        <Table columns="1.2fr 0.8fr 0.8fr 2.2fr 1fr 1fr 0.9fr" minWidth={960}>
          <Row head>
            <span>Quote no</span>
            <span>Date</span>
            <span>Valid till</span>
            <span>Client · proposal</span>
            <span>Project</span>
            <span className="text-right">Amount</span>
            <span>Status</span>
          </Row>
          {quotes.map((q) => (
            <Row key={q.id}>
              <Link href={`/quotes/${q.id}`} className="font-mono text-[12px] hover:text-primary">
                {q.number}
                {q.revision > 0 ? ` · R${q.revision}` : ''}
              </Link>
              <span className="text-muted">{formatDate(q.quoteDate)}</span>
              <span className={q.status === 'expired' ? 'text-danger' : 'text-muted'}>
                {formatDate(q.validTill)}
              </span>
              <span className="min-w-0">
                <span className="block truncate">{q.clientName}</span>
                <span className="block truncate text-xs text-muted">{q.title}</span>
              </span>
              <span className="text-muted">{q.projectCode ?? '—'}</span>
              <span className="num text-right">{rupees(q.total)}</span>
              <span>
                <Pill tone={QUOTE_STATUS[q.status].tone}>{QUOTE_STATUS[q.status].label}</Pill>
              </span>
            </Row>
          ))}
        </Table>
      )}
      {adding ? (
        <QuoteDrawer
          quote={null}
          clients={clients}
          companyStateCode={companyStateCode}
          onClose={() => setAdding(false)}
          onSaved={(id) => router.push(`/quotes/${id}`)}
        />
      ) : null}
    </>
  );
}
