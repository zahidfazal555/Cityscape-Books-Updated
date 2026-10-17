import {
  DomainError,
  ZERO_TAX,
  addHeads,
  advanceTax,
  buildGstr1,
  fromDecimalString,
  monthRange,
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
  /** Output tax after advances, before set-off. */
  liability: TaxHeads;
  setOff: SetOff;
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
const nonNegative = (t: TaxHeads): TaxHeads => ({
  igst: Math.max(0, t.igst),
  cgst: Math.max(0, t.cgst),
  sgst: Math.max(0, t.sgst),
});

/**
 * GST returns for one month (Req §4.15): GSTR-3B summary, GSTR-1 tables, Table 11A/11B
 * advances, ITC register and the GSTR-1 JSON. Built from the documents themselves; a month's
 * credit-ledger balance from earlier months is not carried in v1.
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
      const received = await advancesOf(c, 'received', from, to, company.state_code);
      const adjusted = await advancesOf(c, 'adjusted', from, to, company.state_code);
      const itcRegister = await itcOf(c, from, to);
      const invoicesTotal = sumAmounts(invoices.flatMap((i) => i.items));
      const creditNotesTotal = sumAmounts(creditNotes.flatMap((n) => n.items));
      const advancesReceived = sumAmounts(received);
      const advancesAdjusted = sumAmounts(adjusted);
      const outward = {
        taxable: invoicesTotal.taxable - creditNotesTotal.taxable,
        tax: addHeads(invoicesTotal.tax, creditNotesTotal.tax, -1),
      };
      const itc = itcRegister
        .filter((b) => b.eligible)
        .reduce((s, b) => addHeads(s, b.tax), ZERO_TAX);
      const liability = nonNegative(
        addHeads(addHeads(outward.tax, advancesReceived.tax), advancesAdjusted.tax, -1),
      );
      return {
        period,
        from,
        to,
        dueDate: returnDueDate(period),
        outward,
        invoicesTotal,
        creditNotesTotal,
        advancesReceived,
        advancesAdjusted,
        itc,
        liability,
        setOff: setOff(liability, itc),
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
    hsn: string;
    rate: string;
    qty_milli: string;
    taxable: string;
    igst: string;
    cgst: string;
    sgst: string;
  }>(
    `SELECT sac_hsn AS hsn, gst_rate::text AS rate, (sum(sign * qty) * 1000)::bigint::text AS qty_milli,
            sum(sign * taxable)::text AS taxable, sum(sign * igst)::text AS igst, sum(sign * cgst)::text AS cgst,
            sum(sign * sgst)::text AS sgst
       FROM (
         SELECT 1 AS sign, l.* FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id
          WHERE i.invoice_date BETWEEN $1 AND $2
         UNION ALL
         SELECT -1 AS sign, l.* FROM invoice_line l JOIN credit_note n ON n.invoice_id = l.invoice_id
          WHERE n.cn_date BETWEEN $1 AND $2
       ) x
      GROUP BY sac_hsn, gst_rate HAVING sum(sign * taxable) <> 0 ORDER BY sac_hsn, gst_rate`,
    [from, to],
  );
  return rows.map((r) => ({
    hsn: r.hsn,
    rate: Number(r.rate),
    qtyMilli: Number(r.qty_milli),
    taxable: p(r.taxable),
    tax: heads(r),
  }));
}

/**
 * 11A ('received'): advances received in the month and not applied to an invoice in it.
 * 11B ('adjusted'): advances received before the month and applied to an invoice in it.
 * Tax = amount × r / (100 + r), pro rata over the proforma's rates (SPEC-FIXES A7).
 */
async function advancesOf(
  c: pg.PoolClient,
  kind: 'received' | 'adjusted',
  from: IsoDate,
  to: IsoDate,
  companyState: string,
): Promise<AdvanceRow[]> {
  const where =
    kind === 'received'
      ? `r.receipt_date BETWEEN $1 AND $2 AND (a.applied_at IS NULL OR a.applied_at > $2)`
      : `a.applied_at BETWEEN $1 AND $2 AND r.receipt_date < $1`;
  const { rows } = await c.query<{
    receipt_number: string;
    receipt_date: string;
    proforma_number: string;
    proforma_id: string;
    pos: string;
    amount: string;
  }>(
    `SELECT r.number AS receipt_number, to_char(r.receipt_date, 'YYYY-MM-DD') AS receipt_date,
            f.number AS proforma_number, f.id AS proforma_id, f.place_of_supply AS pos, a.amount::text
       FROM receipt_allocation a JOIN receipt r ON r.id = a.receipt_id JOIN proforma f ON f.id = a.proforma_id
      WHERE r.deleted_at IS NULL AND ${where}
      ORDER BY r.receipt_date, r.number`,
    [from, to],
  );
  const out: AdvanceRow[] = [];
  for (const r of rows) {
    const shares = await c.query<{ rate: string; value: string }>(
      `SELECT gst_rate::text AS rate, round(sum(qty * rate), 2)::text AS value FROM proforma_line
        WHERE proforma_id = $1 GROUP BY gst_rate ORDER BY gst_rate`,
      [r.proforma_id],
    );
    const amount = p(r.amount);
    const t = advanceTax(
      amount,
      shares.rows.map((s) => ({ rate: Number(s.rate), value: p(s.value) })),
      r.pos !== companyState,
    );
    out.push({
      receiptNumber: r.receipt_number,
      receiptDate: r.receipt_date,
      proformaNumber: r.proforma_number,
      amount,
      taxable: t.taxable,
      tax: t.tax,
    });
  }
  return out;
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
