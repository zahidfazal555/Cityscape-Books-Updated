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

function nextMonthDay(period: string, day: number): IsoDate {
  const { from } = monthRange(period);
  const y = Number(from.slice(0, 4));
  const m = Number(from.slice(5, 7));
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return `${next}-${String(day).padStart(2, '0')}`;
}

/** GSTR-3B (and its cash payment) is due on the 20th of the next month (FR-15.1). */
export function returnDueDate(period: string): IsoDate {
  return nextMonthDay(period, 20);
}

/** Monthly GSTR-1 is due on the 11th of the next month. */
export function gstr1DueDate(period: string): IsoDate {
  return nextMonthDay(period, 11);
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
 * Input-credit set-off (CGST Act s.49(5), Rule 88A): IGST credit is used first: against IGST,
 * then against CGST and SGST in whatever split leaves the least cash to pay, i.e. where the
 * head's own credit falls short first (BUG-122). Only then CGST credit (against CGST, then
 * IGST) and SGST credit (against SGST, then IGST). CGST never pays SGST, nor SGST CGST.
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
  const apply = (from: keyof TaxHeads, to: keyof TaxHeads, cap = Infinity) => {
    const n = Math.min(left[from], due[to], cap);
    left[from] -= n;
    due[to] -= n;
    used[to] += n;
  };
  apply('igst', 'igst');
  // IGST credit goes first to the shortfall its own CGST/SGST credit cannot cover.
  apply('igst', 'cgst', Math.max(0, due.cgst - left.cgst));
  apply('igst', 'sgst', Math.max(0, due.sgst - left.sgst));
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
  /** Phase-III Table 12: B2B and B2C supplies are reported separately. */
  b2b: boolean;
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

/** Inter-state invoices to unregistered buyers above this go to b2cl, one by one (from Aug 2024). */
export const B2CL_LIMIT: Paise = 1_00_000_00;

const isB2cl = (d: { ctin: string | null; interState: boolean; total: Paise }) =>
  !d.ctin && d.interState && d.total > B2CL_LIMIT;

/**
 * Small B2C supplies, summarised by place of supply and rate, net of credit notes on them
 * (BUG-121). Rows that net to zero are dropped.
 */
function b2csOf(invoices: readonly Gstr1Invoice[], notes: readonly Gstr1CreditNote[]) {
  const map = new Map<
    string,
    { pos: string; inter: boolean; rt: number; taxable: Paise; tax: TaxHeads }
  >();
  const add = (d: Gstr1Invoice | Gstr1CreditNote, sign: 1 | -1) => {
    for (const it of d.items) {
      const k = `${d.pos}|${it.rate}`;
      const cur = map.get(k) ?? {
        pos: d.pos,
        inter: d.interState,
        rt: it.rate,
        taxable: 0,
        tax: ZERO_TAX,
      };
      map.set(k, {
        ...cur,
        taxable: cur.taxable + sign * it.taxable,
        tax: addHeads(cur.tax, it.tax, sign),
      });
    }
  };
  invoices.filter((v) => !v.ctin && !isB2cl(v)).forEach((v) => add(v, 1));
  notes.filter((n) => !n.ctin && !isB2cl(n)).forEach((n) => add(n, -1));
  return [...map.values()]
    .filter((x) => x.taxable !== 0)
    .map((x) => ({
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

function b2clOf(invoices: readonly Gstr1Invoice[]) {
  const byPos = new Map<string, Gstr1Invoice[]>();
  for (const v of invoices.filter(isB2cl)) byPos.set(v.pos, [...(byPos.get(v.pos) ?? []), v]);
  return [...byPos].map(([pos, invs]) => ({
    pos,
    inv: invs.map((v) => ({
      inum: v.number,
      idt: gstnDate(v.date),
      val: r(v.total),
      itms: itms(v.items),
    })),
  }));
}

/** Credit notes on b2cl invoices (unregistered, large inter-state). */
function cdnurOf(notes: readonly Gstr1CreditNote[]) {
  return notes.filter(isB2cl).map((n) => ({
    typ: 'B2CL',
    ntty: 'C',
    nt_num: n.number,
    nt_dt: gstnDate(n.date),
    pos: n.pos,
    val: r(n.total),
    itms: itms(n.items),
  }));
}

/** SAC (services, 99xx) take UQC "NA" and no quantity. */
function hsnOf(rows: readonly Gstr1Hsn[]) {
  return rows.map((h, i) => {
    const service = h.hsn.startsWith('99');
    return {
      num: i + 1,
      hsn_sc: h.hsn,
      desc: '',
      uqc: service ? 'NA' : 'OTH',
      qty: service ? 0 : h.qtyMilli / 1000,
      rt: h.rate,
      txval: r(h.taxable),
      iamt: r(h.tax.igst),
      camt: r(h.tax.cgst),
      samt: r(h.tax.sgst),
      csamt: 0,
    };
  });
}

/**
 * GSTR-1 in the GSTN offline-tool JSON shape (FR-15.6): b2b, b2cl, b2cs, cdnr, cdnur and the
 * Phase-III HSN table split into hsn_b2b and hsn_b2c.
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
  return {
    gstin: input.gstin,
    fp: `${from.slice(5, 7)}${from.slice(0, 4)}`,
    b2b,
    b2cl: b2clOf(input.invoices),
    b2cs: b2csOf(input.invoices, input.creditNotes),
    cdnr,
    cdnur: cdnurOf(input.creditNotes),
    hsn: {
      hsn_b2b: hsnOf(input.hsn.filter((h) => h.b2b)),
      hsn_b2c: hsnOf(input.hsn.filter((h) => !h.b2b)),
    },
  };
}
