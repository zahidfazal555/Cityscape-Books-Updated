'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  MATERIAL_CATEGORIES,
  formatDate,
  formatQty,
  parseQty,
  parseRupees,
  todayIn,
  type MaterialCategory,
} from '@csd/core';
import type { InventoryView as View } from '@csd/services';
import { Button, EmptyState, Field, FormError, Input } from '@/components/ui';
import { Drawer, PageHeader, Row, Table } from '@/components/kit';
import { DownloadLink } from '@/components/accounts/tabs';
import { Cards } from '@/components/sales/filter-chips';
import { selectCls, useAction, type ProjectOption } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import { rupees } from '@/lib/format';

/** README §15 / FR-18.2: filter by project, category cards, purchase table, record and export. */
export function InventoryView({
  view,
  projectId,
  projects,
  formProjects,
  me,
  rights,
}: {
  view: View;
  projectId: string | null;
  projects: ProjectOption[];
  formProjects: ProjectOption[];
  me: string;
  rights: { edit: boolean; full: boolean };
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const remove = useAction();
  const query = projectId ? `?projectId=${projectId}` : '';
  return (
    <>
      <PageHeader
        title="Inventory · material purchases"
        subtitle="Purchase tracking only: the cost reaches the books through the bill or expense."
        action={
          <div className="flex gap-2">
            <DownloadLink href={`/api/v1/inventory/export${query}`}>Export CSV</DownloadLink>
            {rights.edit ? (
              <Button onClick={() => setAdding(true)}>+ Record purchase</Button>
            ) : null}
          </div>
        }
      />
      <div className="mb-4 max-w-xs">
        <label htmlFor="inv-project" className="sr-only">
          Project
        </label>
        <select
          id="inv-project"
          className={selectCls}
          value={projectId ?? ''}
          onChange={(e) =>
            router.push(e.target.value ? `/inventory?projectId=${e.target.value}` : '/inventory')
          }
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name}
            </option>
          ))}
        </select>
      </div>
      <Cards
        items={[
          ['All materials', rupees(view.total)],
          ...view.byCategory
            .slice(0, 5)
            .map((c) => [`${c.category} · ${c.count}`, rupees(c.amount)] as const),
        ]}
      />
      <FormError message={remove.error} />
      {view.purchases.length === 0 ? (
        <EmptyState>No material purchases recorded.</EmptyState>
      ) : (
        <Table columns="0.8fr 1.8fr 0.8fr 0.8fr 1.3fr 0.9fr 0.9fr 0.9fr 0.5fr" minWidth={1080}>
          <Row head>
            <span>Date</span>
            <span>Item</span>
            <span>Category</span>
            <span>Project</span>
            <span>Vendor</span>
            <span className="text-right">Quantity</span>
            <span className="text-right">Amount</span>
            <span className="text-right">Avg rate</span>
            <span />
          </Row>
          {view.purchases.map((m) => (
            <Row key={m.id}>
              <span className="text-muted">{formatDate(m.purchaseDate)}</span>
              <span className="truncate">{m.item}</span>
              <span>{m.category}</span>
              <span className="font-mono text-[12px]">{m.projectCode}</span>
              <span className="truncate text-muted">{m.vendorName}</span>
              <span className="num text-right">
                {formatQty(m.qtyMilli)} {m.unit}
              </span>
              <span className="num text-right">{rupees(m.amount)}</span>
              <span className="num text-right text-muted">{rupees(m.averageRate)}</span>
              <span className="text-right text-xs">
                {rights.full || (rights.edit && m.createdBy === me) ? (
                  <button
                    type="button"
                    className="text-danger"
                    disabled={remove.busy}
                    onClick={() => {
                      if (!window.confirm(`Remove ${m.item}?`)) return;
                      void remove.run(() =>
                        apiFetch(`/api/v1/inventory/${m.id}`, { method: 'DELETE' }),
                      );
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </span>
            </Row>
          ))}
        </Table>
      )}
      {adding ? (
        <PurchaseDrawer
          projects={formProjects}
          projectId={projectId}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function PurchaseDrawer({
  projects,
  projectId: initialProject,
  onClose,
  onSaved,
}: {
  projects: ProjectOption[];
  projectId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [projectId, setProjectId] = useState(initialProject ?? '');
  const [purchaseDate, setDate] = useState(todayIn());
  const [item, setItem] = useState('');
  const [category, setCategory] = useState<MaterialCategory>('Board');
  const [unit, setUnit] = useState('Nos');
  const [qty, setQty] = useState('');
  const [amount, setAmount] = useState('');
  const [vendorName, setVendor] = useState('');
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const save = () =>
    run(
      () =>
        apiFetch('/api/v1/inventory', {
          method: 'POST',
          idempotencyKey,
          body: {
            projectId,
            purchaseDate,
            item,
            category,
            unit,
            qtyMilli: parseQty(qty.trim() || '0', 'qtyMilli'),
            amount: parseRupees(amount.trim() || '0', 'amount'),
            vendorName,
          },
        }),
      () => onSaved(),
    );
  return (
    <Drawer
      title="Record purchase"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Record'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Project" htmlFor="m-project">
          <select
            id="m-project"
            className={selectCls}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Choose a project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Item" htmlFor="m-item">
          <Input id="m-item" value={item} onChange={(e) => setItem(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category" htmlFor="m-cat">
            <select
              id="m-cat"
              className={selectCls}
              value={category}
              onChange={(e) => setCategory(e.target.value as MaterialCategory)}
            >
              {MATERIAL_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Date" htmlFor="m-date">
            <Input
              id="m-date"
              type="date"
              value={purchaseDate}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Quantity" htmlFor="m-qty">
            <Input
              id="m-qty"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </Field>
          <Field label="Unit" htmlFor="m-unit">
            <Input id="m-unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
          </Field>
          <Field label="Amount (₹)" htmlFor="m-amt">
            <Input
              id="m-amt"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Vendor" htmlFor="m-vendor">
          <Input id="m-vendor" value={vendorName} onChange={(e) => setVendor(e.target.value)} />
        </Field>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
