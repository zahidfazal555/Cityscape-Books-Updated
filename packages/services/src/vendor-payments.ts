import { randomUUID } from 'node:crypto';
import {
  ACCOUNT_FOR_MODE,
  DomainError,
  PAYMENT_MODES,
  assertId,
  assertNotLocked,
  authorize,
  can,
  formatInr,
  fromDecimalString,
  projectScope,
  requiresApproval,
  toDecimalString,
  todayIn,
  type Actor,
  type IsoDate,
  type Paise,
  type PaymentMode,
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
import { loadBill, type BillDetail } from './bills.js';
import { companyRow, isoDate, parse, tenantOf as ctx } from './validation.js';

export type PaymentStatus = 'pending' | 'approved' | 'rejected';

const paymentSchema = z
  .object({
    billId: z.string().uuid('Choose a bill.'),
    payDate: isoDate,
    /** Settled against the bill, before TDS. */
    amount: z.number().int('Amount must be in paise.').positive('Amount must be more than zero.'),
    /** Tax deducted at source and paid to the government instead of the vendor. */
    tds: z.number().int().min(0).default(0),
    mode: z.enum(PAYMENT_MODES),
    reference: z.string().trim().max(100).nullable().optional(),
    paidBy: z.string().trim().max(80).nullable().optional(),
  })
  .refine((r) => r.mode === 'cash' || (r.reference ?? '').length > 0, {
    message: 'Enter the reference (UTR, UPI or cheque number).',
    path: ['reference'],
  })
  .refine((r) => r.tds < r.amount, { message: 'TDS must be less than the amount.', path: ['tds'] });
const rejectSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason.').max(500) });

export type PaymentInput = z.input<typeof paymentSchema>;

export interface VendorPayment {
  id: string;
  billId: string;
  billNo: string;
  vendorName: string;
  projectId: string;
  projectCode: string;
  payDate: IsoDate;
  amount: Paise;
  tds: Paise;
  mode: PaymentMode;
  reference: string | null;
  paidBy: string | null;
  status: PaymentStatus;
  rejectReason: string | null;
  submittedBy: string | null;
  submittedAt: string;
}

const SELECT = `
  SELECT v.id, v.bill_id, b.bill_no, b.vendor_name, v.project_id, p.code AS project_code,
         to_char(v.pay_date, 'YYYY-MM-DD') AS pay_date, v.amount::text, v.tds::text, v.mode, v.reference,
         v.paid_by, v.status, v.reject_reason, u.name AS submitted_by, v.created_at, v.created_by, v.journal_id
    FROM vendor_payment v
    JOIN bill b ON b.id = v.bill_id
    JOIN project p ON p.id = v.project_id
    LEFT JOIN app_user u ON u.id = v.created_by
   WHERE v.deleted_at IS NULL`;

interface Row {
  id: string;
  bill_id: string;
  bill_no: string;
  vendor_name: string;
  project_id: string;
  project_code: string;
  pay_date: string;
  amount: string;
  tds: string;
  mode: PaymentMode;
  reference: string | null;
  paid_by: string | null;
  status: PaymentStatus;
  reject_reason: string | null;
  submitted_by: string | null;
  created_at: Date;
}

const toPayment = (r: Row): VendorPayment => ({
  id: r.id,
  billId: r.bill_id,
  billNo: r.bill_no,
  vendorName: r.vendor_name,
  projectId: r.project_id,
  projectCode: r.project_code,
  payDate: r.pay_date,
  amount: fromDecimalString(r.amount),
  tds: fromDecimalString(r.tds),
  mode: r.mode,
  reference: r.reference,
  paidBy: r.paid_by,
  status: r.status,
  rejectReason: r.reject_reason,
  submittedBy: r.submitted_by,
  submittedAt: r.created_at.toISOString(),
});

/**
 * Vendor payments (FR-10.3, SPEC-FIXES A1): Dr accounts payable / Cr bank (net of TDS) /
 * Cr TDS payable. ENGINEERING-STANDARDS H2: a non-owner's payment is Pending and posts nothing
 * until the owner approves it; the owner's own payments post at once.
 */
export class VendorPaymentsService {
  constructor(private readonly pool: pg.Pool) {}

  async list(
    actor: Actor,
    filter: { billId?: string | undefined; status?: PaymentStatus | undefined } = {},
  ): Promise<VendorPayment[]> {
    authorize(actor, 'bills', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Row>(
        `${SELECT}
           AND ($1::uuid[] IS NULL OR v.project_id = ANY($1::uuid[]))
           AND ($2::uuid IS NULL OR v.bill_id = $2) AND ($3::text IS NULL OR v.status = $3)
         ORDER BY v.pay_date DESC, v.created_at DESC LIMIT 500`,
        [projectScope(actor), filter.billId ?? null, filter.status ?? null],
      );
      return rows.map(toPayment);
    });
  }

  /** The owner's queue (Approvals → Payments). */
  async pending(actor: Actor): Promise<VendorPayment[]> {
    authorize(actor, 'approvals', 'full');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Row>(
        `${SELECT} AND v.status = 'pending' ORDER BY v.created_at`,
      );
      return rows.map(toPayment);
    });
  }

  /** Pays (part of) a bill. Pending for non-approvers; posted at once for the owner. */
  async record(actor: Actor, input: PaymentInput): Promise<{ id: string; status: PaymentStatus }> {
    const data = parse(paymentSchema, input);
    authorize(actor, 'bills', 'edit');
    if (data.payDate > todayIn())
      throw new DomainError('VALIDATION', 'A payment cannot be dated in the future.', 'payDate');
    return withTenant(this.pool, ctx(actor), async (c) => {
      // Lock the bill first: two payments can never together exceed its balance.
      const bill = await loadBill(c, actor, data.billId, true).catch(() => {
        throw new DomainError('NOT_FOUND', 'Bill not found.');
      });
      authorize(actor, 'bills', 'edit', bill.projectId);
      if (data.payDate < bill.billDate) {
        throw new DomainError(
          'VALIDATION',
          'The payment cannot be dated before the bill.',
          'payDate',
        );
      }
      const open = bill.balance - bill.pending;
      if (data.amount > open) {
        throw new DomainError(
          'VALIDATION',
          `The amount is more than the balance due (${formatInr(Math.max(0, open))}${
            bill.pending > 0 ? `, after ${formatInr(bill.pending)} waiting for approval` : ''
          }).`,
          'amount',
        );
      }
      const company = await companyRow(c);
      assertNotLocked(data.payDate, company.lock_date, 'payDate');
      const id = randomUUID();
      const approved = !requiresApproval(actor);
      const journalId = approved ? await postPayment(c, id, data, bill) : null;
      await c.query(
        `INSERT INTO vendor_payment (id, company_id, bill_id, vendor_id, project_id, pay_date, amount, tds, mode,
                                     reference, paid_by, account_code, status, decided_by, decided_at, journal_id,
                                     created_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 CASE WHEN $13 THEN app_user_id() END, CASE WHEN $13 THEN now() END, $14, app_user_id())`,
        [
          id,
          data.billId,
          bill.vendorId,
          bill.projectId,
          data.payDate,
          toDecimalString(data.amount),
          toDecimalString(data.tds),
          data.mode,
          data.reference || null,
          data.paidBy ?? null,
          ACCOUNT_FOR_MODE[data.mode],
          approved ? 'approved' : 'pending',
          approved,
          journalId,
        ],
      );
      await writeAudit(c, {
        action: 'create',
        entity: 'vendor_payment',
        entityId: id,
        after: { ...data, status: approved ? 'approved' : 'pending' },
      });
      return { id, status: approved ? 'approved' : 'pending' };
    });
  }

  /** The owner approves a pending payment; it posts, dated its payment date. */
  async approve(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Payment');
    authorize(actor, 'approvals', 'full');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const pay = await this.pendingFor(c, actor, id);
      const bill = await loadBill(c, actor, pay.billId, true);
      // The pending amount is already held against the balance; it must still fit.
      if (pay.amount > bill.balance)
        throw new DomainError('CONFLICT', 'This payment is more than the bill balance now.');
      const company = await companyRow(c);
      assertNotLocked(pay.payDate, company.lock_date, 'payDate');
      const journalId = await postPayment(c, id, pay, bill);
      await c.query(
        `UPDATE vendor_payment SET status = 'approved', journal_id = $2, decided_by = app_user_id(),
                decided_at = now() WHERE id = $1`,
        [id, journalId],
      );
      await writeAudit(c, { action: 'approve', entity: 'vendor_payment', entityId: id });
    });
  }

  async reject(actor: Actor, id: string, input: z.input<typeof rejectSchema>): Promise<void> {
    assertId(id, 'Payment');
    const data = parse(rejectSchema, input);
    authorize(actor, 'approvals', 'full');
    await withTenant(this.pool, ctx(actor), async (c) => {
      await this.pendingFor(c, actor, id);
      await c.query(
        `UPDATE vendor_payment SET status = 'rejected', reject_reason = $2, decided_by = app_user_id(),
                decided_at = now() WHERE id = $1`,
        [id, data.reason],
      );
      await writeAudit(c, {
        action: 'reject',
        entity: 'vendor_payment',
        entityId: id,
        after: { reason: data.reason },
      });
    });
  }

  /**
   * Deletes a payment (`bills = full`, open period). An approved one is reversed; a pending one
   * may also be withdrawn by whoever entered it.
   */
  async remove(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Payment');
    authorize(actor, 'bills', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const pay = await this.lockPayment(c, actor, id);
      const own = pay.status === 'pending' && pay.createdBy === actor.userId;
      if (!own) authorize(actor, 'bills', 'full', pay.projectId);
      if (pay.status === 'rejected')
        throw new DomainError(
          'CONFLICT',
          'A rejected payment posts nothing; there is nothing to delete.',
        );
      const reversal =
        pay.status === 'approved' && pay.journalId
          ? await reverseJournal(
              c,
              pay.journalId,
              pay.payDate,
              `Vendor payment on ${pay.billNo} deleted`,
            )
          : null;
      await c.query(
        `UPDATE vendor_payment SET deleted_at = now(), deleted_by = app_user_id(), reversal_journal_id = $2
          WHERE id = $1`,
        [id, reversal],
      );
      await writeAudit(c, {
        action: 'delete',
        entity: 'vendor_payment',
        entityId: id,
        before: { billNo: pay.billNo, amount: pay.amount, status: pay.status },
      });
    });
  }

  private async pendingFor(c: pg.PoolClient, actor: Actor, id: string) {
    const pay = await this.lockPayment(c, actor, id);
    if (pay.status !== 'pending')
      throw new DomainError('CONFLICT', `This payment is already ${pay.status}.`);
    return pay;
  }

  /** Bill first, then the payment: the same order as recording, so no deadlock. */
  private async lockPayment(c: pg.PoolClient, actor: Actor, id: string) {
    await c.query(
      `SELECT 1 FROM bill WHERE id = (SELECT bill_id FROM vendor_payment WHERE id = $1) FOR UPDATE`,
      [id],
    );
    const { rows } = await c.query<Row & { created_by: string | null; journal_id: string | null }>(
      `${SELECT} AND v.id = $1 FOR UPDATE OF v`,
      [id],
    );
    const r = rows[0];
    if (!r || !can(actor, 'bills', 'view', r.project_id))
      throw new DomainError('NOT_FOUND', 'Payment not found.');
    return { ...toPayment(r), createdBy: r.created_by, journalId: r.journal_id };
  }
}

/** Dr AP (vendor) / Cr bank, cash or UPI for the net / Cr TDS payable. */
async function postPayment(
  c: pg.PoolClient,
  id: string,
  pay: { payDate: IsoDate; amount: Paise; tds: Paise; mode: PaymentMode },
  bill: BillDetail,
): Promise<string> {
  const lines: JournalLineInput[] = [
    { accountCode: '2000', debit: pay.amount, contactId: bill.vendorId, projectId: bill.projectId },
    {
      accountCode: ACCOUNT_FOR_MODE[pay.mode],
      credit: pay.amount - pay.tds,
      projectId: bill.projectId,
    },
  ];
  if (pay.tds > 0) lines.push({ accountCode: '2310', credit: pay.tds, projectId: bill.projectId });
  return postJournal(c, {
    txnDate: pay.payDate,
    sourceType: 'vendor_payment',
    sourceId: id,
    narration: `Payment to ${bill.vendorName} for bill ${bill.billNo}`,
    lines,
  });
}
