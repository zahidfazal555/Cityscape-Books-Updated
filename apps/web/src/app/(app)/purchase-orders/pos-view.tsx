'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDate } from '@csd/core';
import type { PoSummary } from '@csd/services';
import { Button, EmptyState } from '@/components/ui';
import { PageHeader, Pill, Row, Table } from '@/components/kit';
import type { VendorOption } from '@/components/purchases/bill-drawer';
import { Cards, FilterChips } from '@/components/sales/filter-chips';
import type { ProjectOption } from '@/components/sales/use-action';
import { rupees } from '@/lib/format';
import { PO_STATUS } from '@/lib/purchases';
import { PoDrawer } from './po-drawer';

const FILTERS = [
  ['all', 'All'],
  ['draft', 'Draft'],
  ['issued', 'Issued'],
  ['partly_billed', 'Partly billed'],
  ['billed', 'Billed'],
  ['cancelled', 'Cancelled'],
] as const;

export function PosView({
  pos,
  all,
  filter,
  canEdit,
  vendors,
  projects,
  companyStateCode,
}: {
  pos: PoSummary[];
  all: PoSummary[];
  filter: string;
  canEdit: boolean;
  vendors: VendorOption[];
  projects: ProjectOption[];
  companyStateCode: string;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const open = all.filter((p) => p.status === 'issued' || p.status === 'partly_billed');
  return (
    <>
      <PageHeader
        title="Purchase orders"
        subtitle="Commitments to vendors PO/FY/####. A PO posts nothing; its bills do."
        action={canEdit ? <Button onClick={() => setAdding(true)}>+ New PO</Button> : null}
      />
      <Cards
        items={[
          ['Open orders (unbilled)', rupees(open.reduce((s, p) => s + p.unbilled, 0))],
          ['Billed against POs', rupees(all.reduce((s, p) => s + p.billed, 0))],
          ['Drafts', String(all.filter((p) => p.status === 'draft').length)],
        ]}
      />
      <FilterChips base="/purchase-orders" options={FILTERS} value={filter} />
      {pos.length === 0 ? (
        <EmptyState>No purchase orders here yet.</EmptyState>
      ) : (
        <Table columns="1.1fr 0.8fr 1.9fr 0.9fr 0.9fr 1fr 1fr 0.9fr" minWidth={1000}>
          <Row head>
            <span>PO no</span>
            <span>Date</span>
            <span>Vendor</span>
            <span>Project</span>
            <span>Deliver by</span>
            <span className="text-right">Amount</span>
            <span className="text-right">Billed</span>
            <span>Status</span>
          </Row>
          {pos.map((p) => (
            <Row key={p.id}>
              <Link
                href={`/purchase-orders/${p.id}`}
                className="font-mono text-[12px] hover:text-primary"
              >
                {p.number}
              </Link>
              <span className="text-muted">{formatDate(p.poDate)}</span>
              <span className="min-w-0">
                <span className="block truncate">{p.vendorName}</span>
                <span className="block truncate text-xs text-muted">
                  {p.vendorGstin ?? 'Unregistered'}
                </span>
              </span>
              <span className="text-muted">{p.projectCode}</span>
              <span className={p.overdue ? 'text-danger' : 'text-muted'}>
                {p.deliverBy ? formatDate(p.deliverBy) : '—'}
              </span>
              <span className="num text-right">{rupees(p.total)}</span>
              <span className="num text-right">{rupees(p.billed)}</span>
              <span>
                <Pill tone={PO_STATUS[p.status].tone}>{PO_STATUS[p.status].label}</Pill>
              </span>
            </Row>
          ))}
        </Table>
      )}
      {adding ? (
        <PoDrawer
          po={null}
          vendors={vendors}
          projects={projects}
          companyStateCode={companyStateCode}
          onClose={() => setAdding(false)}
          onSaved={(id) => router.push(`/purchase-orders/${id}`)}
        />
      ) : null}
    </>
  );
}
