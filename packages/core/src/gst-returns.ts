import { DomainError } from './errors.js';
import { monthRange, type IsoDate } from './dates.js';
import { mulDivHalfUp, toBasisPoints, toDecimalString, type Paise } from './money.js';

export interface TaxHeads {
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
}

export const ZERO_TAX: TaxHeads = { igst: 0, cgst: 0, sgst: 0 };

export function addHeads(a: TaxHeads, b: TaxHeads, sign: 1 | -1 = 1): TaxHeads {
  return {
    igst: a.igst + sign * b.igst,
    cgst: a.cgst + sign * b.cgst,
    sgst: a.sgst + sign * b.sgst,
  };
}

/** GSTR-1 and GSTR-3B are due on the 20th of the following month (FR-15.1). */
export function returnDueDate(period: string): IsoDate {
  const { from } = monthRange(period);
  const y = Number(from.slice(0, 4));
  const m = Number(from.slice(5, 7));
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return `${next}-20`;
}

/**
 * Tax contained in an advance received (Table 11A, SPEC-FIXES A7): amount × r / (100 + r),
 * split by place of supply. `shares` gives the document's GST rates by value; a mixed-rate
 * proforma splits the advance pro rata.
 */
export function advanceTax(
  amount: Paise,
  shares: readonly { rate: number; value: Paise }[],
  interState: boolean,
): { taxable: Paise; tax: TaxHeads } {
  const totalValue = shares.reduce((s, x) => s + x.value, 0);
  if (amount === 0 || totalValue <= 0) return { taxable: amount, tax: ZERO_TAX };
  let tax = 0;
  let allocated = 0;
  shares.forEach((x, i) => {
    // The last share takes the remainder, so the parts always add up to the amount.
    const part =
      i === shares.length - 1 ? amount - allocated : mulDivHalfUp(amount, x.value, totalValue);
    allocated += part;
    const bp = toBasisPoints(x.rate);
    tax += mulDivHalfUp(part, bp, 10_000 + bp);
  });
  if (interState) return { taxable: amount - tax, tax: { igst: tax, cgst: 0, sgst: 0 } };
  const cgst = Math.floor(tax / 2);
  return { taxable: amount - tax, tax: { igst: 0, cgst, sgst: tax - cgst } };
}

export interface SetOff {
  /** Paid from the electronic credit ledger, per liability head. */
  creditUsed: TaxHeads;
  /** Left to pay in cash (GSTR-3B 6.1). */
  cash: TaxHeads;
  /** Input credit left over, carried forward. */
  carryForward: TaxHeads;
}

/**
 * Input-credit set-off order (CGST Act s.49, Rule 88A): IGST credit first, against IGST, then
 * CGST and SGST; then CGST credit against CGST, then IGST; then SGST credit against SGST, then
 * IGST. CGST credit never pays SGST, nor SGST credit CGST.
 */
export function setOff(liability: TaxHeads, credit: TaxHeads): SetOff {
  if (Object.values(liability).some((v) => v < 0)) {
    throw new DomainError('VALIDATION', 'Output tax cannot be negative for set-off.');
  }
  const due = { ...liability };
  const left = {
    igst: Math.max(0, credit.igst),
    cgst: Math.max(0, credit.cgst),
    sgst: Math.max(0, credit.sgst),
  };
  const used = { ...ZERO_TAX };
  const apply = (from: keyof TaxHeads, to: keyof TaxHeads) => {
    const n = Math.min(left[from], due[to]);
    left[from] -= n;
    due[to] -= n;
    used[to] += n;
  };
  apply('igst', 'igst');
  apply('igst', 'cgst');
  apply('igst', 'sgst');
  apply('cgst', 'cgst');
  apply('cgst', 'igst');
  apply('sgst', 'sgst');
  apply('sgst', 'igst');
  return { creditUsed: used, cash: due, carryForward: left };
}

/** GSTN amounts are rupees with two decimals as JSON numbers. */
const r = (p: Paise): number => Number(toDecimalString(p));
/** GSTN dates are dd-mm-yyyy. */
const gstnDate = (d: IsoDate): string => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;

export interface Gstr1Invoice {
  number: string;
  date: IsoDate;
  /** Null for an unregistered buyer (B2C). */
  ctin: string | null;
  pos: string;
  interState: boolean;
  total: Paise;
  /** One row per GST rate. */
  items: { rate: number; taxable: Paise; tax: TaxHeads }[];
}

export interface Gstr1CreditNote {
  number: string;
  date: IsoDate;
  ctin: string | null;
  pos: string;
  interState: boolean;
  total: Paise;
  items: { rate: number; taxable: Paise; tax: TaxHeads }[];
}

export interface Gstr1Hsn {
  hsn: string;
  rate: number;
  qtyMilli: number;
  taxable: Paise;
  tax: TaxHeads;
}

function itms(items: Gstr1Invoice['items']) {
  return items.map((it, i) => ({
    num: i + 1,
    itm_det: {
      rt: it.rate,
      txval: r(it.taxable),
      iamt: r(it.tax.igst),
      camt: r(it.tax.cgst),
      samt: r(it.tax.sgst),
      csamt: 0,
    },
  }));
}

function byCtin<T extends { ctin: string | null }>(rows: readonly T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of rows) {
    if (!x.ctin) continue;
    m.set(x.ctin, [...(m.get(x.ctin) ?? []), x]);
  }
  return m;
}

/** Unregistered buyers, summarised by place of supply and rate. */
function b2csOf(invoices: readonly Gstr1Invoice[]) {
  const b2csMap = new Map<
    string,
    { pos: string; inter: boolean; rt: number; taxable: Paise; tax: TaxHeads }
  >();
  for (const v of invoices.filter((x) => !x.ctin)) {
    for (const it of v.items) {
      const k = `${v.pos}|${it.rate}`;
      const cur = b2csMap.get(k) ?? {
        pos: v.pos,
        inter: v.interState,
        rt: it.rate,
        taxable: 0,
        tax: ZERO_TAX,
      };
      b2csMap.set(k, { ...cur, taxable: cur.taxable + it.taxable, tax: addHeads(cur.tax, it.tax) });
    }
  }
  return [...b2csMap.values()].map((x) => ({
    sply_ty: x.inter ? 'INTER' : 'INTRA',
    pos: x.pos,
    typ: 'OE',
    rt: x.rt,
    txval: r(x.taxable),
    iamt: r(x.tax.igst),
    camt: r(x.tax.cgst),
    samt: r(x.tax.sgst),
    csamt: 0,
  }));
}

function hsnOf(rows: readonly Gstr1Hsn[]) {
  return rows.map((h, i) => ({
    num: i + 1,
    hsn_sc: h.hsn,
    uqc: 'OTH',
    qty: h.qtyMilli / 1000,
    rt: h.rate,
    txval: r(h.taxable),
    iamt: r(h.tax.igst),
    camt: r(h.tax.cgst),
    samt: r(h.tax.sgst),
    csamt: 0,
  }));
}

/**
 * GSTR-1 in the GSTN offline-tool JSON shape (FR-15.6): b2b, b2cs, cdnr, hsn. B2C invoices are
 * summarised by place of supply and rate (b2cs). v1 does not split out b2cl or b2c HSN rows.
 */
export function buildGstr1(input: {
  gstin: string;
  period: string;
  invoices: readonly Gstr1Invoice[];
  creditNotes: readonly Gstr1CreditNote[];
  hsn: readonly Gstr1Hsn[];
}) {
  const { from } = monthRange(input.period);
  const b2b = [...byCtin(input.invoices)].map(([ctin, invs]) => ({
    ctin,
    inv: invs.map((v) => ({
      inum: v.number,
      idt: gstnDate(v.date),
      val: r(v.total),
      pos: v.pos,
      rchrg: 'N',
      inv_typ: 'R',
      itms: itms(v.items),
    })),
  }));
  const b2cs = b2csOf(input.invoices);
  const cdnr = [...byCtin(input.creditNotes)].map(([ctin, notes]) => ({
    ctin,
    nt: notes.map((n) => ({
      ntty: 'C',
      nt_num: n.number,
      nt_dt: gstnDate(n.date),
      pos: n.pos,
      rchrg: 'N',
      inv_typ: 'R',
      val: r(n.total),
      itms: itms(n.items),
    })),
  }));
  const hsn = { data: hsnOf(input.hsn) };
  return {
    gstin: input.gstin,
    fp: `${from.slice(5, 7)}${from.slice(0, 4)}`,
    b2b,
    b2cs,
    cdnr,
    hsn,
  };
}
