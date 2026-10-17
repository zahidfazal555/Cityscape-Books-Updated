import {
  DomainError,
  ZERO_TAX,
  addHeads,
  advanceTax,
  buildGstr1,
  fromDecimalString,
  monthRange,
  gstr1DueDate,
  returnDueDate,
  setOff,
  type Actor,
  type Gstr1CreditNote,
  type Gstr1Hsn,
  type Gstr1Invoice,
  type IsoDate,
  type Paise,
  type SetOff,
  type TaxHeads,
} from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { assertCompanyWide } from './banking.js';
import { companyRow, tenantOf as ctx } from './validation.js';

export interface Amounts {
  taxable: Paise;
  tax: TaxHeads;
}

export interface ItcRow {
  billId: string;
  billNo: string;
  billDate: IsoDate;
  vendorName: string;
  vendorGstin: string | null;
  taxable: Paise;
  tax: TaxHeads;
  eligible: boolean;
}

export interface AdvanceRow {
  /** 11A: received, or released again by a credit note; 11B: applied to an invoice, or refunded. */
  event: 'received' | 'released' | 'applied' | 'refunded';
  receiptNumber: string;
  receiptDate: IsoDate;
  proformaNumber: string;
  amount: Paise;
  taxable: Paise;
  tax: TaxHeads;
}

export interface GstMonth {
  period: string;
  from: IsoDate;
  to: IsoDate;
  dueDate: IsoDate;
  /** GSTR-3B 3.1(a): invoices, less credit notes, in the month. */
  outward: Amounts;
  invoicesTotal: Amounts;
  creditNotesTotal: Amounts;
  /** 11A: advances received this month and not invoiced in it; 11B: earlier advances adjusted. */
  advancesReceived: Amounts;
  advancesAdjusted: Amounts;
  /** 4(A)(5): eligible input credit on bills of the month. */
  itc: TaxHeads;
  /** Output tax after advances, before set-off (never below zero per head). */
  liability: TaxHeads;
  /** Credit brought forward from earlier months (unused ITC and excess credit-note tax). */
  openingCredit: TaxHeads;
  setOff: SetOff;
  gstr1DueDate: IsoDate;
  invoices: Gstr1Invoice[];
  creditNotes: Gstr1CreditNote[];
  hsn: Gstr1Hsn[];
  advances: { received: AdvanceRow[]; adjusted: AdvanceRow[] };
  itcRegister: ItcRow[];
}

const p = fromDecimalString;
const heads = (r: { igst: string; cgst: string; sgst: string }): TaxHeads => ({
  igst: p(r.igst),
  cgst: p(r.cgst),
  sgst: p(r.sgst),
});
const sumAmounts = (rows: readonly Amounts[]): Amounts =>
  rows.reduce((s, x) => ({ taxable: s.taxable + x.taxable, tax: addHeads(s.tax, x.tax) }), {
    taxable: 0,
    tax: ZERO_TAX,
  });
const positive = (t: TaxHeads): TaxHeads => ({
  igst: Math.max(0, t.igst),
  cgst: Math.max(0, t.cgst),
  sgst: Math.max(0, t.sgst),
});
const negativePart = (t: TaxHeads): TaxHeads => ({
  igst: Math.max(0, -t.igst),
  cgst: Math.max(0, -t.cgst),
  sgst: Math.max(0, -t.sgst),
});

/**
 * GST returns for one month (Req §4.15): GSTR-3B summary, GSTR-1 tables, Table 11A/11B
 * advances, ITC register and the GSTR-1 JSON. Built from the documents and the dated advance
 * history; unused credit and excess credit-note tax carry forward month to month (BUG-124).
 */
export class GstService {
  constructor(private readonly pool: pg.Pool) {}

  async month(actor: Actor, period: string): Promise<GstMonth> {
    assertCompanyWide(actor, 'view', 'gst');
    const { from, to } = range(period);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const company = await companyRow(c);
      const invoices = await invoicesOf(c, from, to);
      const creditNotes = await creditNotesOf(c, from, to);
      const hsn = await hsnOf(c, from, to);
      const advances = await advanceMovements(c, to, company.state_code);
      const itcRegister = await itcOf(c, from, to);
      const chain = await creditChain(c, period, advances);
      const received = advances
        .filter((a) => a.period === period && a.sign === 1)
        .map((a) => a.row);
      const adjusted = advances
        .filter((a) => a.period === period && a.sign === -1)
        .map((a) => a.row);
      const invoicesTotal = sumAmounts(invoices.flatMap((i) => i.items));
      const creditNotesTotal = sumAmounts(creditNotes.flatMap((n) => n.items));
      return {
        period,
        from,
        to,
        dueDate: returnDueDate(period),
        gstr1DueDate: gstr1DueDate(period),
        outward: {
          taxable: invoicesTotal.taxable - creditNotesTotal.taxable,
          tax: addHeads(invoicesTotal.tax, creditNotesTotal.tax, -1),
        },
        invoicesTotal,
        creditNotesTotal,
        advancesReceived: sumAmounts(received),
        advancesAdjusted: sumAmounts(adjusted),
        itc: itcRegister
          .filter((b) => b.eligible)
          .reduce((sum, b) => addHeads(sum, b.tax), ZERO_TAX),
        liability: chain.liability,
        openingCredit: chain.opening,
        setOff: chain.setOff,
        invoices,
        creditNotes,
        hsn,
        advances: { received, adjusted },
        itcRegister,
      };
    });
  }

  /** FR-15.6: GSTR-1 in the GSTN offline-tool shape. The download is audited (H4). */
  async gstr1Json(actor: Actor, period: string): Promise<ReturnType<typeof buildGstr1>> {
    const m = await this.month(actor, period);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{ gstin: string | null }>('SELECT gstin FROM company');
      const gstin = rows[0]?.gstin;
      if (!gstin) throw new DomainError('VALIDATION', 'Add the company GSTIN in settings first.');
      await writeAudit(c, {
        action: 'export',
        entity: 'gstr1',
        entityId: null,
        after: { format: 'json', period, invoices: m.invoices.length },
      });
      return buildGstr1({
        gstin,
        period,
        invoices: m.invoices,
        creditNotes: m.creditNotes,
        hsn: m.hsn,
      });
    });
  }
}

function range(period: string): { from: IsoDate; to: IsoDate } {
  try {
    return monthRange(period);
  } catch {
    throw new DomainError('VALIDATION', 'Choose a month (YYYY-MM).', 'period');
  }
}

interface ItemRow {
  doc_id: string;
  number: string;
  date: string;
  ctin: string | null;
  pos: string;
  inter: boolean;
  total: string;
  rate: string;
  taxable: string;
  igst: string;
  cgst: string;
  sgst: string;
}

/** Rows of (document, rate) → documents with one item per rate. */
function group(rows: ItemRow[]): Gstr1Invoice[] {
  const by = new Map<string, Gstr1Invoice>();
  for (const r of rows) {
    const doc = by.get(r.doc_id) ?? {
      number: r.number,
      date: r.date,
      ctin: r.ctin,
      pos: r.pos,
      interState: r.inter,
      total: p(r.total),
      items: [],
    };
    doc.items.push({ rate: Number(r.rate), taxable: p(r.taxable), tax: heads(r) });
    by.set(r.doc_id, doc);
  }
  return [...by.values()];
}

/** Every tax invoice dated in the month, cancelled or not: its credit note reverses it in its own month. */
async function invoicesOf(c: pg.PoolClient, from: IsoDate, to: IsoDate): Promise<Gstr1Invoice[]> {
  const { rows } = await c.query<ItemRow>(
    `SELECT i.id AS doc_id, i.number, to_char(i.invoice_date, 'YYYY-MM-DD') AS date, i.client_gstin AS ctin,
            i.place_of_supply AS pos, i.is_inter_state AS inter, i.total::text, l.gst_rate::text AS rate,
            sum(l.taxable)::text AS taxable, sum(l.igst)::text AS igst, sum(l.cgst)::text AS cgst,
            sum(l.sgst)::text AS sgst
       FROM invoice i JOIN invoice_line l ON l.invoice_id = i.id
      WHERE i.invoice_date BETWEEN $1 AND $2
      GROUP BY i.id, l.gst_rate ORDER BY i.invoice_date, i.number, l.gst_rate`,
    [from, to],
  );
  return group(rows);
}

/** Credit notes dated in the month; each reverses its whole invoice (FR-3.3.4). */
async function creditNotesOf(
  c: pg.PoolClient,
  from: IsoDate,
  to: IsoDate,
): Promise<Gstr1CreditNote[]> {
  const { rows } = await c.query<ItemRow>(
    `SELECT n.id AS doc_id, n.number, to_char(n.cn_date, 'YYYY-MM-DD') AS date, i.client_gstin AS ctin,
            i.place_of_supply AS pos, i.is_inter_state AS inter, n.total::text, l.gst_rate::text AS rate,
            sum(l.taxable)::text AS taxable, sum(l.igst)::text AS igst, sum(l.cgst)::text AS cgst,
            sum(l.sgst)::text AS sgst
       FROM credit_note n JOIN invoice i ON i.id = n.invoice_id JOIN invoice_line l ON l.invoice_id = i.id
      WHERE n.cn_date BETWEEN $1 AND $2
      GROUP BY n.id, i.id, l.gst_rate ORDER BY n.cn_date, n.number, l.gst_rate`,
    [from, to],
  );
  return group(rows);
}

/** HSN/SAC summary, net of credit notes issued in the month. */
async function hsnOf(c: pg.PoolClient, from: IsoDate, to: IsoDate): Promise<Gstr1Hsn[]> {
  const { rows } = await c.query<{
    b2b: boolean;
    hsn: string;
    rate: string;
    qty_milli: string;
    taxable: string;
    igst: string;
    cgst: string;
    sgst: string;
  }>(
    `SELECT b2b, sac_hsn AS hsn, gst_rate::text AS rate, (sum(sign * qty) * 1000)::bigint::text AS qty_milli,
            sum(sign * taxable)::text AS taxable, sum(sign * igst)::text AS igst, sum(sign * cgst)::text AS cgst,
            sum(sign * sgst)::text AS sgst
       FROM (
         SELECT 1 AS sign, (i.client_gstin IS NOT NULL) AS b2b, l.* FROM invoice_line l
           JOIN invoice i ON i.id = l.invoice_id
          WHERE i.invoice_date BETWEEN $1 AND $2
         UNION ALL
         SELECT -1 AS sign, (i.client_gstin IS NOT NULL) AS b2b, l.* FROM invoice_line l
           JOIN credit_note n ON n.invoice_id = l.invoice_id JOIN invoice i ON i.id = l.invoice_id
          WHERE n.cn_date BETWEEN $1 AND $2
       ) x
      GROUP BY b2b, sac_hsn, gst_rate HAVING sum(sign * taxable) <> 0 ORDER BY b2b DESC, sac_hsn, gst_rate`,
    [from, to],
  );
  return rows.map((r) => ({
    b2b: r.b2b,
    hsn: r.hsn,
    rate: Number(r.rate),
    qtyMilli: Number(r.qty_milli),
    taxable: p(r.taxable),
    tax: heads(r),
  }));
}

type Change = { date: IsoDate; held: boolean; why: AdvanceRow['event'] };

/** One movement per month in which what is held at month end changes. */
function monthlyMoves(changes: readonly Change[], base: Omit<AdvanceRow, 'event'>): Movement[] {
  const out: Movement[] = [];
  let held = false;
  for (const period of [...new Set(changes.map((x) => x.date.slice(0, 7)))].sort()) {
    const last = changes.filter((x) => x.date.slice(0, 7) === period).at(-1);
    if (!last || last.held === held) continue;
    held = last.held;
    out.push({ period, sign: held ? 1 : -1, row: { event: last.why, ...base } });
  }
  return out;
}

interface Movement {
  period: string;
  /** +1 adds the advance's tax (11A), −1 takes it out (11B). */
  sign: 1 | -1;
  row: AdvanceRow;
}

/**
 * Advance tax movements up to `until`, from each advance's dated history (BUG-120): it is
 * "held" from its receipt date, not held once applied to an invoice, held again when that
 * invoice is cancelled, and gone once the receipt is deleted. A month reports the change in
 * what is held at its end: received and applied in the same month nets to nothing.
 */
async function advanceMovements(
  c: pg.PoolClient,
  until: IsoDate,
  companyState: string,
): Promise<Movement[]> {
  const { rows } = await c.query<{
    id: string;
    amount: string;
    receipt_number: string;
    receipt_date: string;
    deleted_on: string | null;
    proforma_id: string;
    proforma_number: string;
    pos: string;
  }>(
    `SELECT a.id, a.amount::text, r.number AS receipt_number, to_char(r.receipt_date, 'YYYY-MM-DD') AS receipt_date,
            to_char((r.deleted_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS deleted_on,
            f.id AS proforma_id, f.number AS proforma_number, f.place_of_supply AS pos
       FROM receipt_allocation a JOIN receipt r ON r.id = a.receipt_id JOIN proforma f ON f.id = a.proforma_id
      WHERE r.receipt_date <= $1`,
    [until],
  );
  if (rows.length === 0) return [];
  const events = await c.query<{
    allocation_id: string;
    kind: 'applied' | 'released';
    date: string;
  }>(
    `SELECT allocation_id, kind, to_char(event_date, 'YYYY-MM-DD') AS date FROM advance_event
      WHERE allocation_id = ANY($1::uuid[]) AND event_date <= $2 ORDER BY event_date, created_at`,
    [rows.map((r) => r.id), until],
  );
  const shares = await c.query<{ proforma_id: string; rate: string; value: string }>(
    `SELECT proforma_id, gst_rate::text AS rate, round(sum(qty * rate), 2)::text AS value FROM proforma_line
      WHERE proforma_id = ANY($1::uuid[]) GROUP BY proforma_id, gst_rate ORDER BY gst_rate`,
    [[...new Set(rows.map((r) => r.proforma_id))]],
  );
  const out: Movement[] = [];
  for (const r of rows) {
    const amount = p(r.amount);
    const t = advanceTax(
      amount,
      shares.rows
        .filter((x) => x.proforma_id === r.proforma_id)
        .map((x) => ({ rate: Number(x.rate), value: p(x.value) })),
      r.pos !== companyState,
    );
    const changes: Change[] = [
      { date: r.receipt_date, held: true, why: 'received' },
      ...events.rows
        .filter((e) => e.allocation_id === r.id)
        .map((e) => ({
          date: e.date,
          held: e.kind === 'released',
          why: (e.kind === 'released' ? 'released' : 'applied') as AdvanceRow['event'],
        })),
      ...(r.deleted_on && r.deleted_on <= until
        ? [{ date: r.deleted_on, held: false, why: 'refunded' as const }]
        : []),
    ];
    out.push(
      ...monthlyMoves(changes, {
        receiptNumber: r.receipt_number,
        receiptDate: r.receipt_date,
        proformaNumber: r.proforma_number,
        amount,
        taxable: t.taxable,
        tax: t.tax,
      }),
    );
  }
  return out;
}

/**
 * Runs every month up to `period` (from the first month with any GST activity), carrying
 * unused ITC and excess credit-note tax forward like the electronic credit ledger.
 */
async function creditChain(
  c: pg.PoolClient,
  period: string,
  advances: readonly Movement[],
): Promise<{ opening: TaxHeads; liability: TaxHeads; setOff: SetOff }> {
  const { rows } = await c.query<{
    period: string;
    kind: string;
    igst: string;
    cgst: string;
    sgst: string;
  }>(
    `SELECT to_char(i.invoice_date, 'YYYY-MM') AS period, 'out' AS kind, sum(l.igst)::text AS igst,
            sum(l.cgst)::text AS cgst, sum(l.sgst)::text AS sgst
       FROM invoice i JOIN invoice_line l ON l.invoice_id = i.id
      WHERE to_char(i.invoice_date, 'YYYY-MM') <= $1 GROUP BY 1
     UNION ALL
     SELECT to_char(n.cn_date, 'YYYY-MM'), 'cn', sum(l.igst)::text, sum(l.cgst)::text, sum(l.sgst)::text
       FROM credit_note n JOIN invoice_line l ON l.invoice_id = n.invoice_id
      WHERE to_char(n.cn_date, 'YYYY-MM') <= $1 GROUP BY 1
     UNION ALL
     SELECT to_char(bill_date, 'YYYY-MM'), 'itc', sum(igst)::text, sum(cgst)::text, sum(sgst)::text
       FROM bill WHERE deleted_at IS NULL AND itc_eligible AND to_char(bill_date, 'YYYY-MM') <= $1 GROUP BY 1`,
    [period],
  );
  const months = [
    ...new Set([...rows.map((r) => r.period), ...advances.map((a) => a.period), period]),
  ]
    .filter((m) => m <= period)
    .sort();
  let carry = ZERO_TAX;
  let result = { opening: ZERO_TAX, liability: ZERO_TAX, setOff: setOff(ZERO_TAX, ZERO_TAX) };
  for (const m of months) {
    const of = (kind: string) => {
      const r = rows.find((x) => x.period === m && x.kind === kind);
      return r ? heads(r) : ZERO_TAX;
    };
    const adv = advances
      .filter((a) => a.period === m)
      .reduce((sum, a) => addHeads(sum, a.row.tax, a.sign), ZERO_TAX);
    const raw = addHeads(addHeads(of('out'), of('cn'), -1), adv);
    const credit = addHeads(addHeads(of('itc'), carry), negativePart(raw));
    const liability = positive(raw);
    const so = setOff(liability, credit);
    result = { opening: carry, liability, setOff: so };
    carry = so.carryForward;
  }
  return result;
}

/** FR-15.5: every live bill of the month, marked Eligible or No ITC. */
async function itcOf(c: pg.PoolClient, from: IsoDate, to: IsoDate): Promise<ItcRow[]> {
  const { rows } = await c.query<{
    id: string;
    bill_no: string;
    bill_date: string;
    vendor_name: string;
    vendor_gstin: string | null;
    taxable: string;
    igst: string;
    cgst: string;
    sgst: string;
    itc_eligible: boolean;
  }>(
    `SELECT id, bill_no, to_char(bill_date, 'YYYY-MM-DD') AS bill_date, vendor_name, vendor_gstin,
            taxable::text, igst::text, cgst::text, sgst::text, itc_eligible
       FROM bill WHERE deleted_at IS NULL AND bill_date BETWEEN $1 AND $2 ORDER BY bill_date, bill_no`,
    [from, to],
  );
  return rows.map((r) => ({
    billId: r.id,
    billNo: r.bill_no,
    billDate: r.bill_date,
    vendorName: r.vendor_name,
    vendorGstin: r.vendor_gstin,
    taxable: p(r.taxable),
    tax: heads(r),
    eligible: r.itc_eligible,
  }));
}
