'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDate } from '@csd/core';
import type { ProformaSummary } from '@csd/services';
import { Button, EmptyState } from '@/components/ui';
import { PageHeader, Pill, Row, Table } from '@/components/kit';
import { Cards, FilterChips } from '@/components/sales/filter-chips';
import type { ProjectOption } from '@/components/sales/use-action';
import { rupees } from '@/lib/format';
import { PROFORMA_STATUS } from '@/lib/sales';
import { ProformaDrawer } from './proforma-drawer';

const FILTERS = [
  ['all', 'All'],
  ['draft', 'Draft'],
  ['sent', 'Sent'],
  ['partially_paid', 'Partially paid'],
  ['paid', 'Paid'],
  ['overdue', 'Overdue'],
  ['converted', 'Converted'],
  ['cancelled', 'Cancelled'],
] as const;

export function ProformasView({
  proformas,
  all,
  filter,
  canEdit,
  projects,
  companyStateCode,
}: {
  proformas: ProformaSummary[];
  all: ProformaSummary[];
  filter: string;
  canEdit: boolean;
  projects: ProjectOption[];
  companyStateCode: string;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const open = all.filter((p) => p.status !== 'converted' && p.status !== 'cancelled');
  return (
    <>
      <PageHeader
        title="Proforma invoices"
        subtitle="Payment requests for advances and stages. Not tax invoices: never in receivables or revenue."
        action={canEdit ? <Button onClick={() => setAdding(true)}>+ New proforma</Button> : null}
      />
      <Cards
        items={[
          ['Awaiting payment', rupees(open.reduce((s, p) => s + p.balance, 0))],
          ['Advances held', rupees(open.reduce((s, p) => s + p.advances, 0))],
          ['Converted', String(all.filter((p) => p.status === 'converted').length)],
        ]}
      />
      <FilterChips base="/proformas" options={FILTERS} value={filter} />
      {proformas.length === 0 ? (
        <EmptyState>No proformas here yet.</EmptyState>
      ) : (
        <Table columns="1.1fr 0.8fr 1.8fr 1.2fr 0.8fr 1fr 1fr 1fr" minWidth={1000}>
          <Row head>
            <span>No</span>
            <span>Date</span>
            <span>Client · project</span>
            <span>Stage</span>
            <span>Due</span>
            <span className="text-right">Amount</span>
            <span className="text-right">Advances</span>
            <span>Status</span>
          </Row>
          {proformas.map((p) => (
            <Row key={p.id}>
              <Link
                href={`/proformas/${p.id}`}
                className="font-mono text-[12px] hover:text-primary"
              >
                {p.number}
              </Link>
              <span className="text-muted">{formatDate(p.pfDate)}</span>
              <span className="min-w-0">
                <span className="block truncate">{p.clientName}</span>
                <span className="block text-xs text-muted">{p.projectCode}</span>
              </span>
              <span className="truncate">{p.stage}</span>
              <span className={p.status === 'overdue' ? 'text-danger' : 'text-muted'}>
                {formatDate(p.dueDate)}
              </span>
              <span className="num text-right">{rupees(p.total)}</span>
              <span className="num text-right">{rupees(p.advances)}</span>
              <span>
                <Pill tone={PROFORMA_STATUS[p.status].tone}>{PROFORMA_STATUS[p.status].label}</Pill>
              </span>
            </Row>
          ))}
        </Table>
      )}
      {adding ? (
        <ProformaDrawer
          proforma={null}
          projects={projects}
          companyStateCode={companyStateCode}
          onClose={() => setAdding(false)}
          onSaved={(id) => router.push(`/proformas/${id}`)}
        />
      ) : null}
    </>
  );
}
