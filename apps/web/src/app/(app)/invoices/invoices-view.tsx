'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDate } from '@csd/core';
import type { InvoiceSummary } from '@csd/services';
import { Button, EmptyState } from '@/components/ui';
import { PageHeader, Pill, Row, Table } from '@/components/kit';
import { Cards, FilterChips } from '@/components/sales/filter-chips';
import type { ProjectOption } from '@/components/sales/use-action';
import { rupees } from '@/lib/format';
import { INVOICE_STATUS } from '@/lib/sales';
import { InvoiceDrawer } from './invoice-drawer';

const FILTERS = [
  ['all', 'All'],
  ['unpaid', 'Unpaid'],
  ['partially_paid', 'Partially paid'],
  ['paid', 'Paid'],
  ['overdue', 'Overdue'],
  ['cancelled', 'Cancelled'],
] as const;

export function InvoicesView({
  invoices,
  filter,
  canEdit,
  projects,
  companyStateCode,
}: {
  invoices: InvoiceSummary[];
  filter: string;
  canEdit: boolean;
  projects: ProjectOption[];
  companyStateCode: string;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const live = invoices.filter((i) => i.status !== 'cancelled');
  const sum = (xs: InvoiceSummary[], k: 'total' | 'balance') => xs.reduce((s, i) => s + i[k], 0);
  return (
    <>
      <PageHeader
        title="Tax invoices"
        subtitle="GST invoices CSD/FY/####. Cancelled with a credit note, never deleted."
        action={
          <div className="flex gap-2" data-noprint>
            <a
              href={`/api/v1/invoices/export${filter === 'all' ? '' : `?status=${filter}`}`}
              className="inline-flex h-9 items-center rounded-md border border-input bg-white px-4 text-[13.5px] font-medium text-primary hover:bg-thead"
            >
              Export CSV
            </a>
            {canEdit ? <Button onClick={() => setAdding(true)}>+ New invoice</Button> : null}
          </div>
        }
      />
      <Cards
        items={[
          ['Invoiced (listed)', rupees(sum(live, 'total'))],
          ['Balance due', rupees(sum(live, 'balance'))],
          ['Overdue', String(live.filter((i) => i.status === 'overdue').length)],
        ]}
      />
      <FilterChips base="/invoices" options={FILTERS} value={filter} />
      {invoices.length === 0 ? (
        <EmptyState>No invoices here yet.</EmptyState>
      ) : (
        <Table columns="1.1fr 0.8fr 1.6fr 1fr 0.8fr 1fr 1fr 1fr" minWidth={980}>
          <Row head>
            <span>No</span>
            <span>Date</span>
            <span>Client</span>
            <span>Project</span>
            <span>Tax</span>
            <span className="text-right">Amount</span>
            <span className="text-right">Balance due</span>
            <span>Status</span>
          </Row>
          {invoices.map((i) => (
            <Row key={i.id}>
              <Link href={`/invoices/${i.id}`} className="font-mono text-[12px] hover:text-primary">
                {i.number}
              </Link>
              <span className="text-muted">{formatDate(i.invoiceDate)}</span>
              <span className="truncate">{i.clientName}</span>
              <span className="truncate text-muted">{i.projectCode}</span>
              <span className="text-muted">{i.interState ? 'IGST' : 'CGST+SGST'}</span>
              <span className="num text-right">{rupees(i.total)}</span>
              <span className="num text-right">{rupees(i.balance)}</span>
              <span>
                <Pill tone={INVOICE_STATUS[i.status].tone}>{INVOICE_STATUS[i.status].label}</Pill>
              </span>
            </Row>
          ))}
        </Table>
      )}
      {adding ? (
        <InvoiceDrawer
          projects={projects}
          companyStateCode={companyStateCode}
          onClose={() => setAdding(false)}
          onSaved={(id) => router.push(`/invoices/${id}`)}
        />
      ) : null}
    </>
  );
}
