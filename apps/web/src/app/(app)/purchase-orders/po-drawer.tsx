'use client';

import { useState } from 'react';
import { todayIn } from '@csd/core';
import type { PoDetail } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Chips, Drawer } from '@/components/kit';
import type { VendorOption } from '@/components/purchases/bill-drawer';
import {
  LineGrid,
  blankLine,
  draftOf,
  previewTotals,
  toLines,
  type LineDraft,
} from '@/components/sales/line-grid';
import {
  selectCls,
  textareaCls,
  useAction,
  type ProjectOption,
} from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import { GST_CHIPS } from '@/lib/purchases';

type Rate = (typeof GST_CHIPS)[number];

function initial(po: PoDetail | null) {
  return {
    vendorId: po?.vendorId ?? '',
    projectId: po?.projectId ?? '',
    gstRate: String(po?.gstRate ?? 18) as Rate,
    poDate: po?.poDate ?? todayIn(),
    deliverBy: po?.deliverBy ?? '',
    terms: po?.terms ?? '',
  };
}

/** New / edit purchase order (README §6a): one GST rate for the PO; unregistered vendor → no GST. */
export function PoDrawer({
  po,
  vendors,
  projects,
  companyStateCode,
  onClose,
  onSaved,
}: {
  po: PoDetail | null;
  vendors: VendorOption[];
  projects: ProjectOption[];
  companyStateCode: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [f, setF] = useState(() => initial(po));
  const [lines, setLines] = useState<LineDraft[]>(() =>
    po ? po.lines.map(draftOf) : [blankLine()],
  );
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const vendor = vendors.find((v) => v.id === f.vendorId);
  const registered = po ? po.vendorGstin !== null : Boolean(vendor?.gstin);
  const rate = registered ? Number(f.gstRate) : 0;
  const withRate = lines.map((l) => ({ ...l, gstRate: rate }));
  const state = po?.vendorGstin?.slice(0, 2) ?? vendor?.stateCode ?? null;
  const totals = previewTotals(withRate, { placeOfSupply: state, companyStateCode });

  const save = () =>
    run(
      async () => {
        const body = {
          gstRate: rate,
          poDate: f.poDate,
          deliverBy: f.deliverBy || null,
          lines: toLines(lines).map(({ gstRate: _g, ...l }) => l),
          terms: f.terms.trim() || null,
        };
        if (po) {
          await apiFetch(`/api/v1/purchase-orders/${po.id}`, {
            method: 'PATCH',
            body: { ...body, version: po.version },
          });
          return { id: po.id };
        }
        return apiFetch<{ id: string }>('/api/v1/purchase-orders', {
          method: 'POST',
          idempotencyKey,
          body: { ...body, vendorId: f.vendorId, projectId: f.projectId },
        });
      },
      (r) => onSaved((r as { id: string }).id),
    );

  return (
    <Drawer
      title={po ? `Edit ${po.number}` : 'New purchase order'}
      width={860}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : po ? 'Save changes' : 'Save draft'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {po ? (
          <p className="text-[13px] text-muted">
            {po.vendorName} · deliver to {po.projectCode}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Vendor"
              htmlFor="po-vendor"
              hint={
                vendor
                  ? vendor.gstin
                    ? `GSTIN ${vendor.gstin}`
                    : 'Unregistered: no GST.'
                  : undefined
              }
            >
              <select
                id="po-vendor"
                className={selectCls}
                value={f.vendorId}
                onChange={set('vendorId')}
              >
                <option value="">Choose a vendor…</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Deliver to (project)" htmlFor="po-project">
              <select
                id="po-project"
                className={selectCls}
                value={f.projectId}
                onChange={set('projectId')}
              >
                <option value="">Choose a project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Field label="PO date" htmlFor="po-date">
            <Input id="po-date" type="date" value={f.poDate} onChange={set('poDate')} />
          </Field>
          <Field label="Deliver by" htmlFor="po-by">
            <Input id="po-by" type="date" value={f.deliverBy} onChange={set('deliverBy')} />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-body">GST rate</span>
            {registered ? (
              <Chips
                label="GST rate"
                options={GST_CHIPS.map((r) => ({ value: r, label: `${r}%` }))}
                value={f.gstRate}
                onChange={(gstRate) => setF({ ...f, gstRate })}
              />
            ) : (
              <p className="text-[13px] text-muted">No GST (unregistered vendor).</p>
            )}
          </div>
        </div>
        <LineGrid lines={lines} onChange={setLines} totals={totals} fixedGst={rate} />
        <Field label="Terms" htmlFor="po-terms">
          <textarea id="po-terms" className={textareaCls} value={f.terms} onChange={set('terms')} />
        </Field>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
