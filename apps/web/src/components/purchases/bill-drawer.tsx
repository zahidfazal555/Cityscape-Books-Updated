'use client';

import { useState } from 'react';
import {
  CATEGORY_LABEL,
  COST_CATEGORIES,
  computeDocument,
  parseRupees,
  todayIn,
  type CostCategory,
  type DocumentTotals,
} from '@csd/core';
import type { BillDetail } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Chips, Drawer } from '@/components/kit';
import {
  selectCls,
  textareaCls,
  useAction,
  type ProjectOption,
} from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import { rupees, toRupeeInput } from '@/lib/format';
import { GST_CHIPS } from '@/lib/purchases';

export interface VendorOption {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string;
}

export interface BillPrefill {
  vendorId: string;
  projectId: string;
  gstRate: number;
  taxable: number;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
}

function preview(taxable: string, rate: number, vendor: VendorOption | undefined, company: string) {
  if (!vendor) return null;
  try {
    const t = parseRupees(taxable || '0');
    if (t <= 0) return null;
    return computeDocument(
      [
        {
          description: 'Bill',
          sacHsn: '9954',
          qtyMilli: 1000,
          unit: 'lot',
          rate: t,
          gstRate: vendor.gstin ? rate : 0,
        },
      ],
      { placeOfSupply: vendor.stateCode, companyStateCode: company },
    );
  } catch {
    return null;
  }
}

const BLANK = {
  vendorId: '',
  projectId: '',
  billNo: '',
  billDate: '',
  dueDate: '',
  category: 'material' as CostCategory,
  taxable: '',
  gstRate: '18' as (typeof GST_CHIPS)[number],
  itcEligible: true,
  notes: '',
};
type Form = typeof BLANK;

function initial(bill: BillDetail | null, prefill: BillPrefill | null): Form {
  if (bill) {
    return {
      vendorId: bill.vendorId,
      projectId: bill.projectId,
      billNo: bill.billNo,
      billDate: bill.billDate,
      dueDate: bill.dueDate,
      category: bill.category,
      taxable: toRupeeInput(bill.taxable),
      gstRate: String(bill.gstRate) as Form['gstRate'],
      itcEligible: bill.itcEligible,
      notes: bill.notes ?? '',
    };
  }
  if (prefill) {
    return {
      ...BLANK,
      billDate: todayIn(),
      vendorId: prefill.vendorId,
      projectId: prefill.projectId,
      taxable: toRupeeInput(prefill.taxable),
      gstRate: String(prefill.gstRate) as Form['gstRate'],
    };
  }
  return { ...BLANK, billDate: todayIn() };
}

/** An existing bill keeps its own GSTIN snapshot; a new one takes the vendor's. */
function vendorFor(
  bill: BillDetail | null,
  vendors: VendorOption[],
  vendorId: string,
  companyStateCode: string,
): VendorOption | undefined {
  if (!bill) return vendors.find((v) => v.id === vendorId);
  return {
    id: bill.vendorId,
    name: bill.vendorName,
    gstin: bill.vendorGstin,
    stateCode: bill.vendorGstin?.slice(0, 2) ?? companyStateCode,
  };
}

function titleOf(bill: BillDetail | null, prefill: BillPrefill | null): string {
  if (bill) return `Edit bill ${bill.billNo}`;
  return prefill ? `Bill against ${prefill.purchaseOrderNumber}` : 'New purchase bill';
}

/** Purchase bill form (README §7): IGST for out-of-state vendors; no GSTIN, no GST. */
export function BillDrawer({
  bill = null,
  prefill = null,
  vendors,
  projects,
  companyStateCode,
  onClose,
  onSaved,
}: {
  bill?: BillDetail | null;
  prefill?: BillPrefill | null;
  vendors: VendorOption[];
  projects: ProjectOption[];
  companyStateCode: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [f, setF] = useState(() => initial(bill, prefill));
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const vendor = vendorFor(bill, vendors, f.vendorId, companyStateCode);
  const totals = preview(f.taxable, Number(f.gstRate), vendor, companyStateCode);

  const save = () =>
    run(
      async () => {
        const body = {
          billNo: f.billNo,
          billDate: f.billDate,
          ...(f.dueDate ? { dueDate: f.dueDate } : {}),
          category: f.category,
          taxable: parseRupees(f.taxable || '0', 'taxable'),
          gstRate: Number(f.gstRate),
          itcEligible: f.itcEligible,
          notes: f.notes.trim() || null,
        };
        if (bill) {
          await apiFetch(`/api/v1/bills/${bill.id}`, {
            method: 'PATCH',
            body: { ...body, version: bill.version },
          });
          return { id: bill.id };
        }
        return apiFetch<{ id: string }>('/api/v1/bills', {
          method: 'POST',
          idempotencyKey,
          body: {
            ...body,
            vendorId: f.vendorId,
            projectId: f.projectId,
            ...(prefill ? { purchaseOrderId: prefill.purchaseOrderId } : {}),
          },
        });
      },
      (r) => onSaved((r as { id: string }).id),
    );

  return (
    <Drawer
      title={titleOf(bill, prefill)}
      width={620}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : bill ? 'Save changes' : 'Save bill'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {bill || prefill ? (
          <p className="text-[13px] text-muted">
            {vendor?.name} {vendor?.gstin ? `· GSTIN ${vendor.gstin}` : '· unregistered (no GST)'}
          </p>
        ) : (
          <>
            <Field
              label="Vendor"
              htmlFor="b-vendor"
              hint={
                vendor
                  ? vendor.gstin
                    ? `GSTIN ${vendor.gstin}`
                    : 'Unregistered: no GST, no input credit.'
                  : undefined
              }
            >
              <select
                id="b-vendor"
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
            <Field label="Project" htmlFor="b-project">
              <select
                id="b-project"
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
          </>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Field label="Vendor bill no" htmlFor="b-no">
            <Input id="b-no" value={f.billNo} onChange={set('billNo')} />
          </Field>
          <Field label="Bill date" htmlFor="b-date">
            <Input id="b-date" type="date" value={f.billDate} onChange={set('billDate')} />
          </Field>
          <Field label="Due date" htmlFor="b-due" hint="Blank = vendor terms, else 30 days.">
            <Input id="b-due" type="date" value={f.dueDate} onChange={set('dueDate')} />
          </Field>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-body">Category</span>
          <Chips
            label="Category"
            options={COST_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
            value={f.category}
            onChange={(category) => setF({ ...f, category })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Taxable amount (₹)" htmlFor="b-taxable">
            <Input id="b-taxable" inputMode="decimal" value={f.taxable} onChange={set('taxable')} />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-body">GST rate</span>
            {vendor?.gstin ? (
              <Chips
                label="GST rate"
                options={GST_CHIPS.map((r) => ({ value: r, label: `${r}%` }))}
                value={f.gstRate}
                onChange={(gstRate) => setF({ ...f, gstRate })}
              />
            ) : (
              <p className="text-[13px] text-muted">No GSTIN: no GST.</p>
            )}
          </div>
        </div>
        {vendor?.gstin ? (
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={f.itcEligible}
              onChange={(e) => setF({ ...f, itcEligible: e.target.checked })}
            />
            Input tax credit can be claimed (untick for blocked credit)
          </label>
        ) : null}
        <BillTotals totals={totals} />
        <Field label="Notes (optional)" htmlFor="b-notes">
          <textarea id="b-notes" className={textareaCls} value={f.notes} onChange={set('notes')} />
        </Field>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}

function BillTotals({ totals }: { totals: DocumentTotals | null }) {
  if (!totals) return null;
  const rows: [string, number][] = totals.interState
    ? [['IGST', totals.igst]]
    : [
        ['CGST', totals.cgst],
        ['SGST', totals.sgst],
      ];
  return (
    <dl className="num ml-auto grid min-w-[220px] grid-cols-[1fr_auto] gap-x-6 text-[13px]">
      <dt className="text-muted">Taxable</dt>
      <dd className="text-right">{rupees(totals.taxable)}</dd>
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="text-right">{rupees(v)}</dd>
        </div>
      ))}
      <dt className="text-muted">Round off</dt>
      <dd className="text-right">{rupees(totals.roundOff)}</dd>
      <dt className="border-t border-line pt-1 font-semibold">Total</dt>
      <dd className="border-t border-line pt-1 text-right font-semibold" data-testid="bill-total">
        {rupees(totals.total)}
      </dd>
    </dl>
  );
}
