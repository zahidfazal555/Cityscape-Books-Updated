'use client';

import {
  DEFAULT_SAC,
  GST_RATES,
  computeDocument,
  formatQty,
  parseQty,
  parseRupees,
  type DocumentTotals,
  type Paise,
} from '@csd/core';
import { rupees, toRupeeInput } from '@/lib/format';

/** One editable line, as typed (strings until saved). */
export interface LineDraft {
  description: string;
  sacHsn: string;
  qty: string;
  unit: string;
  rate: string;
  gstRate: number;
}

export interface LineValue {
  description: string;
  sacHsn: string;
  qtyMilli: number;
  unit: string;
  rate: Paise;
  gstRate: number;
}

export const blankLine = (): LineDraft => ({
  description: '',
  sacHsn: DEFAULT_SAC,
  qty: '1',
  unit: 'nos',
  rate: '',
  gstRate: 18,
});

export const draftOf = (l: LineValue): LineDraft => ({
  description: l.description,
  sacHsn: l.sacHsn,
  qty: formatQty(l.qtyMilli),
  unit: l.unit,
  rate: toRupeeInput(l.rate),
  gstRate: l.gstRate,
});

/** Typed lines → API lines (exact paise and thousandths). Throws a field error on bad input. */
export function toLines(lines: readonly LineDraft[]): LineValue[] {
  return lines.map((l, i) => ({
    description: l.description.trim(),
    sacHsn: l.sacHsn.trim(),
    qtyMilli: parseQty(l.qty || '0', `lines.${i}.qty`),
    unit: l.unit.trim() || 'nos',
    rate: parseRupees(l.rate || '0', `lines.${i}.rate`),
    gstRate: l.gstRate,
  }));
}

/** Live totals while typing; null until the lines are complete enough to compute. */
export function previewTotals(
  lines: readonly LineDraft[],
  opts: { placeOfSupply: string | null; companyStateCode: string; discountPct?: number },
): DocumentTotals | null {
  if (!opts.placeOfSupply) return null;
  try {
    return computeDocument(toLines(lines), {
      placeOfSupply: opts.placeOfSupply,
      companyStateCode: opts.companyStateCode,
      discountPct: opts.discountPct ?? 0,
    });
  } catch {
    return null;
  }
}

const cell =
  'h-8 w-full rounded border border-input bg-white px-2 text-[13px] outline-none focus:border-primary';

/** Line grid (description, SAC, qty, unit, rate, GST, amount, ×) with live GST totals. */
export function LineGrid({
  lines,
  onChange,
  totals,
  fixedGst,
}: {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  totals: DocumentTotals | null;
  /** One GST rate for the whole document (purchase orders): the per-line GST column is hidden. */
  fixedGst?: number;
}) {
  const cols =
    fixedGst === undefined
      ? 'grid-cols-[2.6fr_0.9fr_0.7fr_0.7fr_1fr_0.7fr_1fr_28px]'
      : 'grid-cols-[2.6fr_0.9fr_0.7fr_0.7fr_1fr_1fr_28px]';
  const set = (i: number, patch: Partial<LineDraft>) =>
    onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="flex flex-col gap-2">
      <div
        className={`grid ${cols} gap-1.5 text-[11px] font-semibold uppercase tracking-[.05em] text-muted`}
      >
        <span>Description</span>
        <span>SAC/HSN</span>
        <span>Qty</span>
        <span>Unit</span>
        <span>Rate (₹)</span>
        {fixedGst === undefined ? <span>GST</span> : null}
        <span className="text-right">Amount</span>
        <span />
      </div>
      {lines.map((l, i) => (
        <div key={i} className={`grid ${cols} items-center gap-1.5`}>
          <input
            aria-label={`Line ${i + 1} description`}
            className={cell}
            value={l.description}
            onChange={(e) => set(i, { description: e.target.value })}
          />
          <input
            aria-label={`Line ${i + 1} SAC/HSN`}
            className={cell}
            value={l.sacHsn}
            onChange={(e) => set(i, { sacHsn: e.target.value })}
          />
          <input
            aria-label={`Line ${i + 1} quantity`}
            inputMode="decimal"
            className={cell}
            value={l.qty}
            onChange={(e) => set(i, { qty: e.target.value })}
          />
          <input
            aria-label={`Line ${i + 1} unit`}
            className={cell}
            value={l.unit}
            onChange={(e) => set(i, { unit: e.target.value })}
          />
          <input
            aria-label={`Line ${i + 1} rate`}
            inputMode="decimal"
            className={cell}
            value={l.rate}
            onChange={(e) => set(i, { rate: e.target.value })}
          />
          {fixedGst === undefined ? (
            <select
              aria-label={`Line ${i + 1} GST rate`}
              className={cell}
              value={l.gstRate}
              onChange={(e) => set(i, { gstRate: Number(e.target.value) })}
            >
              {GST_RATES.map((r) => (
                <option key={r} value={r}>
                  {r}%
                </option>
              ))}
            </select>
          ) : null}
          <span className="num text-right">
            {totals?.lines[i] ? rupees(totals.lines[i].amount) : '—'}
          </span>
          <button
            type="button"
            aria-label={`Remove line ${i + 1}`}
            disabled={lines.length === 1}
            onClick={() => onChange(lines.filter((_l, j) => j !== i))}
            className="h-7 w-7 rounded text-muted hover:bg-thead disabled:opacity-30"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...lines, blankLine()])}
        className="self-start text-[13px] font-medium text-primary"
      >
        + Add line
      </button>
      <TotalsBox totals={totals} />
    </div>
  );
}

function TotalsBox({ totals }: { totals: DocumentTotals | null }) {
  if (!totals)
    return (
      <p className="text-right text-xs text-muted">Totals appear when every line is filled in.</p>
    );
  const rows: [string, Paise][] = [
    ...(totals.discount > 0
      ? ([
          ['Subtotal', totals.subtotal],
          ['Discount', -totals.discount],
        ] as [string, Paise][])
      : []),
    ['Taxable value', totals.taxable],
    ...(totals.interState
      ? ([['IGST', totals.igst]] as [string, Paise][])
      : ([
          ['CGST', totals.cgst],
          ['SGST', totals.sgst],
        ] as [string, Paise][])),
    ['Round off', totals.roundOff],
  ];
  return (
    <dl className="num ml-auto grid min-w-[240px] grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="text-right">{rupees(v)}</dd>
        </div>
      ))}
      <dt className="border-t border-line pt-1 font-semibold">Total</dt>
      <dd className="border-t border-line pt-1 text-right font-semibold" data-testid="doc-total">
        {rupees(totals.total)}
      </dd>
    </dl>
  );
}
