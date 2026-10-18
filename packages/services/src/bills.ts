import { randomUUID } from 'node:crypto';
import {
  CATEGORY_ACCOUNT,
  COST_CATEGORIES,
  DomainError,
  addDays,
  assertId,
  assertNotLocked,
  authorize,
  can,
  computeDocument,
  fromDecimalString,
  projectScope,
  toDecimalString,
  todayIn,
  type Actor,
  type CostCategory,
  type DocumentTotals,
  type IsoDate,
  type Paise,
} from '@csd/core';
import {
  postJournal,
  reverseJournal,
  withTenant,
  writeAudit,
  type JournalLineInput,
} from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { assertLiveProject, vendorParty } from './purchase-orders.js';
import { companyRow, isoDate, onDuplicate, parse, tenantOf as ctx } from './validation.js';

export const BILL_STATUSES = ['unpaid', 'partially_paid', 'paid', 'overdue'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

const gstRate = z.union([
  z.literal(0),
  z.literal(5),
  z.literal(12),
  z.literal(18),
  z.literal(28),
  z.literal(40),
]);
const fields = {
  billNo: z.string().trim().min(1, "Enter the vendor's bill number.").max(60),
  billDate: isoDate,
  /** Defaults to the vendor's payment terms, else 30 days. */
  dueDate: isoDate.optional(),
  category: z.enum(COST_CATEGORIES),
  taxable: z.number().int('Amount must be in paise.').positive('Enter the taxable amount.'),
  gstRate: gstRate.default(18),
  /** Untick for blocked credit (e.g. food, personal use). Without a vendor GSTIN it is always off. */
  itcEligible: z.boolean().default(true),
  notes: z.string().trim().max(2000).nullable().optional(),
};
const billSchema = z.object({
  vendorId: z.string().uuid('Choose a vendor.'),
  projectId: z.string().uuid('Choose a project.'),
  purchaseOrderId: z.string().uuid().nullable().optional(),
  ...fields,
});
const updateSchema = z.object({ ...fields, version: z.number().int().positive() });

export type BillInput = z.input<typeof billSchema>;
export type BillUpdate = z.input<typeof updateSchema>;

export const DEFAULT_BILL_DAYS = 30;

export interface BillSummary {
  id: string;
  billNo: string;
  billDate: IsoDate;
  dueDate: IsoDate;
  vendorId: string;
  vendorName: string;
  vendorGstin: string | null;
  projectId: string;
  projectCode: string;
  category: CostCategory;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  taxable: Paise;
  gst: Paise;
  total: Paise;
  paid: Paise;
  /** Payments waiting for the owner's approval (H2). */
  pending: Paise;
  balance: Paise;
  status: BillStatus;
}

export interface BillDetail extends BillSummary {
  version: number;
  gstRate: number;
  interState: boolean;
  itcEligible: boolean;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  roundOff: Paise;
  notes: string | null;
}

/** $1 = today. */
const WITH_STATUS = `
  SELECT b.id, b.bill_no, to_char(b.bill_date, 'YYYY-MM-DD') AS bill_date, to_char(b.due_date, 'YYYY-MM-DD') AS due_date,
         b.vendor_id, b.vendor_name, b.vendor_gstin, b.project_id, p.code AS project_code, b.category,
         b.purchase_order_id, o.number AS po_number, b.taxable::text, (b.cgst + b.sgst + b.igst)::text AS gst,
         b.total::text, x.paid::text, x.pending::text, x.balance::text,
         CASE WHEN x.balance <= 0 THEN 'paid'
              WHEN b.due_date < $1::date THEN 'overdue'
              WHEN x.paid > 0 THEN 'partially_paid'
              ELSE 'unpaid' END AS status
    FROM bill b
    JOIN project p ON p.id = b.project_id
    JOIN bill_balance x ON x.bill_id = b.id
    LEFT JOIN purchase_order o ON o.id = b.purchase_order_id
   WHERE b.deleted_at IS NULL`;

interface SummaryRow {
  id: string;
  bill_no: string;
  bill_date: string;
  due_date: string;
  vendor_id: string;
  vendor_name: string;
  vendor_gstin: string | null;
  project_id: string;
  project_code: string;
  category: CostCategory;
  purchase_order_id: string | null;
  po_number: string | null;
  taxable: string;
  gst: string;
  total: string;
  paid: string;
  pending: string;
  balance: string;
  status: BillStatus;
}

const p = fromDecimalString;
const toSummary = (r: SummaryRow): BillSummary => ({
  id: r.id,
  billNo: r.bill_no,
  billDate: r.bill_date,
  dueDate: r.due_date,
  vendorId: r.vendor_id,
  vendorName: r.vendor_name,
  vendorGstin: r.vendor_gstin,
  projectId: r.project_id,
  projectCode: r.project_code,
  category: r.category,
  purchaseOrderId: r.purchase_order_id,
  purchaseOrderNumber: r.po_number,
  taxable: p(r.taxable),
  gst: p(r.gst),
  total: p(r.total),
  paid: p(r.paid),
  pending: p(r.pending),
  balance: p(r.balance),
  status: r.status,
});

/** Purchase bills (Req §4.10, SPEC-FIXES A1/A2): cost recognised once, on the bill date. */
export class BillsService {
  constructor(private readonly pool: pg.Pool) {}

  async list(
    actor: Actor,
    filter: {
      status?: BillStatus | undefined;
      projectId?: string | undefined;
      vendorId?: string | undefined;
      /** Only bills with something left to pay. */
      open?: boolean | undefined;
    } = {},
  ): Promise<BillSummary[]> {
    authorize(actor, 'bills', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<SummaryRow>(
        `SELECT * FROM (${WITH_STATUS}) s
          WHERE ($2::uuid[] IS NULL OR s.project_id = ANY($2::uuid[]))
            AND ($3::text IS NULL OR s.status = $3) AND ($4::uuid IS NULL OR s.project_id = $4)
            AND ($5::uuid IS NULL OR s.vendor_id = $5)
            AND (NOT $6 OR s.balance::numeric - s.pending::numeric > 0)
          ORDER BY s.bill_date DESC, s.bill_no DESC LIMIT 500`,
        [
          todayIn(),
          projectScope(actor),
          filter.status ?? null,
          filter.projectId ?? null,
          filter.vendorId ?? null,
          filter.open ?? false,
        ],
      );
      return rows.map(toSummary);
    });
  }

  async get(actor: Actor, id: string): Promise<BillDetail> {
    assertId(id, 'Bill');
    authorize(actor, 'bills', 'view');
    return withTenant(this.pool, ctx(actor), (c) => loadBill(c, actor, id));
  }

  /** Records a vendor bill and posts it: Dr project cost (+ input GST) / Cr accounts payable. */
  async create(actor: Actor, input: BillInput): Promise<{ id: string }> {
    const data = parse(billSchema, input);
    authorize(actor, 'bills', 'edit');
    if (!can(actor, 'bills', 'view', data.projectId))
      throw new DomainError('NOT_FOUND', 'Project not found.');
    authorize(actor, 'bills', 'edit', data.projectId);
    assertNotFuture(data.billDate);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const company = await companyRow(c);
      assertNotLocked(data.billDate, company.lock_date, 'billDate');
      const vendor = await vendorParty(c, data.vendorId);
      await assertLiveProject(c, data.projectId, true);
      if (data.purchaseOrderId) await assertPo(c, data.purchaseOrderId, data);
      const dueDate = data.dueDate ?? (await defaultDue(c, data.vendorId, data.billDate));
      assertDue(data.billDate, dueDate);
      const t = billTotals(data, vendor, company.state_code);
      const id = randomUUID();
      const journalId = await postJournal(c, {
        txnDate: data.billDate,
        sourceType: 'bill',
        sourceId: id,
        narration: `Bill ${data.billNo} from ${vendor.name}`,
        lines: billJournalLines(t, data.category, data.vendorId, data.projectId),
      });
      await c
        .query(
          `INSERT INTO bill (id, company_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date,
                             project_id, category, purchase_order_id, gst_rate, is_inter_state, itc_eligible,
                             taxable, cgst, sgst, igst, round_off, total, notes, journal_id, created_by, updated_by)
           VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                   $18, $19, $20, $21, app_user_id(), app_user_id())`,
          [
            id,
            data.vendorId,
            vendor.name,
            vendor.gstin,
            data.billNo,
            data.billDate,
            dueDate,
            data.projectId,
            data.category,
            data.purchaseOrderId ?? null,
            t.rate,
            t.totals.interState,
            t.itc,
            ...money(t.totals),
            data.notes ?? null,
            journalId,
          ],
        )
        .catch(onDuplicate('billNo', 'This vendor bill number is already entered.'));
      await writeAudit(c, {
        action: 'create',
        entity: 'bill',
        entityId: id,
        after: { ...data, dueDate, total: t.totals.total },
      });
      return { id };
    });
  }

  /**
   * FR-10.4: edits in an open period only, and never below what is already paid or waiting for
   * approval. The old journal is reversed and a new one posted.
   */
  async update(actor: Actor, id: string, input: BillUpdate): Promise<void> {
    assertId(id, 'Bill');
    const data = parse(updateSchema, input);
    authorize(actor, 'bills', 'edit');
    assertNotFuture(data.billDate);
    await withTenant(this.pool, ctx(actor), async (c) => {
      const before = await loadBill(c, actor, id, true);
      authorize(actor, 'bills', 'edit', before.projectId);
      if (before.version !== data.version) {
        throw new DomainError(
          'CONFLICT',
          'This bill was changed by someone else. Reload it and try again.',
        );
      }
      const company = await companyRow(c);
      assertNotLocked(before.billDate, company.lock_date, 'billDate');
      assertNotLocked(data.billDate, company.lock_date, 'billDate');
      // BUG-101: a tax document keeps the vendor GSTIN it was entered with; later edits to the
      // contact (or archiving it) never change this bill's GST.
      const vendor = snapshotParty(before, company.state_code);
      const dueDate = data.dueDate ?? (await defaultDue(c, before.vendorId, data.billDate));
      assertDue(data.billDate, dueDate);
      await assertBeforePayments(c, id, data.billDate);
      const t = billTotals(data, vendor, company.state_code);
      if (t.totals.total < before.paid + before.pending) {
        throw new DomainError(
          'VALIDATION',
          'The new total is less than what is already paid or waiting for approval.',
          'taxable',
        );
      }
      await reverseJournal(
        c,
        await journalOf(c, id),
        before.billDate,
        `Edit of bill ${before.billNo}: reversal`,
      );
      const journalId = await postJournal(c, {
        txnDate: data.billDate,
        sourceType: 'bill',
        sourceId: id,
        narration: `Bill ${data.billNo} from ${before.vendorName} (edited)`,
        lines: billJournalLines(t, data.category, before.vendorId, before.projectId),
      });
      await c
        .query(
          `UPDATE bill SET bill_no = $2, bill_date = $3, due_date = $4, category = $5, gst_rate = $6,
                  is_inter_state = $7, itc_eligible = $8, taxable = $9, cgst = $10, sgst = $11, igst = $12,
                  round_off = $13, total = $14, notes = $15, journal_id = $16, vendor_gstin = $17,
                  version = version + 1, updated_by = app_user_id()
            WHERE id = $1`,
          [
            id,
            data.billNo,
            data.billDate,
            dueDate,
            data.category,
            t.rate,
            t.totals.interState,
            t.itc,
            ...money(t.totals),
            data.notes ?? null,
            journalId,
            before.vendorGstin,
          ],
        )
        .catch(onDuplicate('billNo', 'This vendor bill number is already entered.'));
      const after = await loadBill(c, actor, id);
      await writeAudit(c, { action: 'update', entity: 'bill', entityId: id, before, after });
    });
  }

  /** FR-10.4: deletes an unpaid bill (`bills = full`, open period). Its journal is reversed. */
  async remove(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Bill');
    authorize(actor, 'bills', 'full');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const bill = await loadBill(c, actor, id, true);
      authorize(actor, 'bills', 'full', bill.projectId);
      if (bill.paid > 0 || bill.pending > 0) {
        throw new DomainError(
          'CONFLICT',
          'This bill has payments (or payments waiting for approval). Delete them first.',
        );
      }
      const reversal = await reverseJournal(
        c,
        await journalOf(c, id),
        bill.billDate,
        `Bill ${bill.billNo} deleted`,
      );
      await c.query(
        `UPDATE bill SET deleted_at = now(), deleted_by = app_user_id(), reversal_journal_id = $2 WHERE id = $1`,
        [id, reversal],
      );
      await writeAudit(c, {
        action: 'delete',
        entity: 'bill',
        entityId: id,
        before: { billNo: bill.billNo, vendor: bill.vendorName, total: bill.total },
      });
    });
  }
}

/** Loads a live, in-scope bill; out of scope is not found. Lock first, then read. */
export async function loadBill(
  c: pg.PoolClient,
  actor: Actor,
  id: string,
  forUpdate = false,
): Promise<BillDetail> {
  if (forUpdate) await c.query('SELECT 1 FROM bill WHERE id = $1 FOR UPDATE', [id]);
  const { rows } = await c.query<
    SummaryRow & {
      version: number;
      gst_rate: string;
      is_inter_state: boolean;
      itc_eligible: boolean;
      cgst: string;
      sgst: string;
      igst: string;
      round_off: string;
      notes: string | null;
    }
  >(
    `SELECT s.*, b.version, b.gst_rate::text, b.is_inter_state, b.itc_eligible, b.cgst::text, b.sgst::text,
            b.igst::text, b.round_off::text, b.notes
       FROM (${WITH_STATUS}) s JOIN bill b ON b.id = s.id WHERE s.id = $2`,
    [todayIn(), id],
  );
  const r = rows[0];
  if (!r || !can(actor, 'bills', 'view', r.project_id))
    throw new DomainError('NOT_FOUND', 'Bill not found.');
  return {
    ...toSummary(r),
    version: r.version,
    gstRate: Number(r.gst_rate),
    interState: r.is_inter_state,
    itcEligible: r.itc_eligible,
    cgst: p(r.cgst),
    sgst: p(r.sgst),
    igst: p(r.igst),
    roundOff: p(r.round_off),
    notes: r.notes,
  };
}

interface BillTotals {
  totals: DocumentTotals;
  rate: number;
  itc: boolean;
}

/**
 * FR-10.2: IGST when the vendor is in another state, else CGST + SGST; no GSTIN means no GST
 * and no input credit. The total is rounded to the rupee (SPEC-FIXES A6).
 */
export function billTotals(
  data: { taxable: Paise; gstRate: number; itcEligible: boolean },
  vendor: { gstin: string | null; state_code: string },
  companyState: string,
): BillTotals {
  const rate = vendor.gstin ? data.gstRate : 0;
  const totals = computeDocument(
    [
      {
        description: 'Bill',
        sacHsn: '9954',
        qtyMilli: 1000,
        unit: 'lot',
        rate: data.taxable,
        gstRate: rate,
      },
    ],
    { placeOfSupply: vendor.state_code, companyStateCode: companyState },
  );
  return { totals, rate, itc: vendor.gstin !== null && data.itcEligible };
}

/**
 * SPEC-FIXES A2: eligible GST goes to input credit, otherwise it is part of the cost. Round-off
 * posts to 4900 on whichever side balances.
 */
export function billJournalLines(
  t: BillTotals,
  category: CostCategory,
  vendorId: string,
  projectId: string,
): JournalLineInput[] {
  const x = t.totals;
  const gst = x.cgst + x.sgst + x.igst;
  const lines: JournalLineInput[] = [
    { accountCode: CATEGORY_ACCOUNT[category], debit: x.taxable + (t.itc ? 0 : gst), projectId },
  ];
  if (t.itc) {
    if (x.cgst) lines.push({ accountCode: '1200', debit: x.cgst, projectId });
    if (x.sgst) lines.push({ accountCode: '1201', debit: x.sgst, projectId });
    if (x.igst) lines.push({ accountCode: '1202', debit: x.igst, projectId });
  }
  if (x.roundOff > 0) lines.push({ accountCode: '4900', debit: x.roundOff, projectId });
  if (x.roundOff < 0) lines.push({ accountCode: '4900', credit: -x.roundOff, projectId });
  lines.push({ accountCode: '2000', credit: x.total, contactId: vendorId, projectId });
  return lines;
}

function money(t: DocumentTotals): string[] {
  return [t.taxable, t.cgst, t.sgst, t.igst, t.roundOff, t.total].map(toDecimalString);
}

/** The bill's own GSTIN snapshot and supply type, as stored when it was entered. */
function snapshotParty(
  bill: Pick<BillDetail, 'vendorGstin' | 'interState'>,
  companyState: string,
): { gstin: string | null; state_code: string } {
  if (!bill.vendorGstin) return { gstin: null, state_code: companyState };
  return { gstin: bill.vendorGstin, state_code: bill.vendorGstin.slice(0, 2) };
}

/** BUG-102: a bill cannot be re-dated after a payment already made (or pending) against it. */
async function assertBeforePayments(
  c: pg.PoolClient,
  billId: string,
  billDate: IsoDate,
): Promise<void> {
  const { rows } = await c.query<{ first: string | null }>(
    `SELECT to_char(min(pay_date), 'YYYY-MM-DD') AS first FROM vendor_payment
      WHERE bill_id = $1 AND deleted_at IS NULL AND status <> 'rejected'`,
    [billId],
  );
  const first = rows[0]?.first;
  if (first && billDate > first) {
    throw new DomainError(
      'VALIDATION',
      `The bill date cannot be after its first payment (${first}).`,
      'billDate',
    );
  }
}

async function assertPo(
  c: pg.PoolClient,
  poId: string,
  data: { vendorId: string; projectId: string },
): Promise<void> {
  const { rows } = await c.query<{ vendor_id: string; project_id: string; status: string }>(
    'SELECT vendor_id, project_id, status FROM purchase_order WHERE id = $1 FOR SHARE',
    [poId],
  );
  const po = rows[0];
  if (!po) throw new DomainError('VALIDATION', 'Purchase order not found.', 'purchaseOrderId');
  if (po.status !== 'issued')
    throw new DomainError(
      'VALIDATION',
      'Bill only against an issued purchase order.',
      'purchaseOrderId',
    );
  if (po.vendor_id !== data.vendorId || po.project_id !== data.projectId) {
    throw new DomainError(
      'VALIDATION',
      'The bill must be for the purchase order’s vendor and project.',
      'purchaseOrderId',
    );
  }
}

async function defaultDue(c: pg.PoolClient, vendorId: string, billDate: IsoDate): Promise<IsoDate> {
  const { rows } = await c.query<{ days: number | null }>(
    'SELECT payment_terms_days AS days FROM contact WHERE id = $1',
    [vendorId],
  );
  return addDays(billDate, rows[0]?.days ?? DEFAULT_BILL_DAYS);
}

async function journalOf(c: pg.PoolClient, billId: string): Promise<string> {
  const { rows } = await c.query<{ journal_id: string }>(
    'SELECT journal_id FROM bill WHERE id = $1',
    [billId],
  );
  const id = rows[0]?.journal_id;
  if (!id) throw new DomainError('NOT_FOUND', 'Bill not found.');
  return id;
}

function assertNotFuture(billDate: IsoDate): void {
  if (billDate > todayIn())
    throw new DomainError('VALIDATION', 'A bill cannot be dated in the future.', 'billDate');
}

function assertDue(billDate: IsoDate, dueDate: IsoDate): void {
  if (dueDate < billDate)
    throw new DomainError('VALIDATION', 'The due date cannot be before the bill date.', 'dueDate');
}
