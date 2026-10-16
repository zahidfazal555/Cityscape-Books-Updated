import { randomUUID } from 'node:crypto';
import {
  DomainError,
  assertId,
  assertNotLocked,
  authorize,
  can,
  formatInr,
  fromDecimalString,
  parseIsoDate,
  projectScope,
  toDecimalString,
  todayIn,
  type Actor,
  type IsoDate,
  type Paise,
} from '@csd/core';
import { allocateNumber, postJournal, reverseJournal, withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { parse, tenantOf as ctx } from './validation.js';

export const RECEIPT_MODES = ['bank', 'upi', 'cash', 'cheque'] as const;
export type ReceiptMode = (typeof RECEIPT_MODES)[number];

/** Where the money lands (chart of accounts in 0001). Cheques clear into the bank account. */
const ACCOUNT_FOR_MODE: Record<ReceiptMode, '1000' | '1010' | '1020'> = {
  cash: '1000',
  bank: '1010',
  cheque: '1010',
  upi: '1020',
};

const receiptSchema = z
  .object({
    invoiceId: z.string().uuid('Choose an invoice.'),
    receiptDate: z.string().refine((d) => {
      try {
        parseIsoDate(d);
        return true;
      } catch {
        return false;
      }
    }, 'Enter a valid date.'),
    amount: z.number().int('Amount must be in paise.').positive('Amount must be more than zero.'),
    mode: z.enum(RECEIPT_MODES),
    reference: z.string().trim().max(100).nullable().optional(),
    receivedBy: z.string().trim().max(80).nullable().optional(),
  })
  .refine((r) => r.mode === 'cash' || (r.reference ?? '').length > 0, {
    message: 'Enter the reference (UTR, UPI or cheque number).',
    path: ['reference'],
  });

export type ReceiptInput = z.input<typeof receiptSchema>;

export interface Receipt {
  id: string;
  number: string;
  receiptDate: IsoDate;
  clientName: string;
  projectId: string;
  projectCode: string;
  invoiceNumber: string | null;
  amount: Paise;
  mode: ReceiptMode;
  reference: string | null;
  receivedBy: string | null;
}

/** Client receipts (Req §6): against an open invoice; amount ≤ balance; reference unless cash. */
export class ReceiptsService {
  constructor(private readonly pool: pg.Pool) {}

  async list(actor: Actor, filter: { projectId?: string | undefined } = {}): Promise<Receipt[]> {
    authorize(actor, 'receipts', 'view');
    const scope = projectScope(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{
        id: string;
        number: string;
        receipt_date: string;
        client_name: string;
        project_id: string;
        project_code: string;
        invoice_number: string | null;
        amount: string;
        mode: ReceiptMode;
        reference: string | null;
        received_by: string | null;
      }>(
        `SELECT r.id, r.number, to_char(r.receipt_date, 'YYYY-MM-DD') AS receipt_date, k.name AS client_name, r.project_id,
                p.code AS project_code,
                (SELECT string_agg(i.number, ', ') FROM receipt_allocation a JOIN invoice i ON i.id = a.invoice_id
                  WHERE a.receipt_id = r.id) AS invoice_number,
                r.amount::text, r.mode, r.reference, r.received_by
           FROM receipt r JOIN contact k ON k.id = r.client_id JOIN project p ON p.id = r.project_id
          WHERE r.deleted_at IS NULL AND ($1::uuid[] IS NULL OR r.project_id = ANY($1::uuid[]))
            AND ($2::uuid IS NULL OR r.project_id = $2)
          ORDER BY r.receipt_date DESC, r.number DESC LIMIT 500`,
        [scope, filter.projectId ?? null],
      );
      return rows.map((r) => ({
        id: r.id,
        number: r.number,
        receiptDate: r.receipt_date,
        clientName: r.client_name,
        projectId: r.project_id,
        projectCode: r.project_code,
        invoiceNumber: r.invoice_number,
        amount: fromDecimalString(r.amount),
        mode: r.mode,
        reference: r.reference,
        receivedBy: r.received_by,
      }));
    });
  }

  /**
   * Records RCT/FY/####: Dr cash/bank/UPI, Cr receivable. The invoice row is locked so two
   * receipts can never together exceed its balance.
   */
  async record(actor: Actor, input: ReceiptInput): Promise<{ id: string; number: string }> {
    const data = parse(receiptSchema, input);
    authorize(actor, 'receipts', 'edit');
    if (data.receiptDate > todayIn()) {
      throw new DomainError(
        'VALIDATION',
        'A receipt cannot be dated in the future.',
        'receiptDate',
      );
    }
    return withTenant(this.pool, ctx(actor), async (c) => {
      const inv = await openInvoice(c, actor, data.invoiceId);
      const company = await checkReceipt(c, data, inv);
      const id = randomUUID();
      const number = await allocateNumber(c, 'receipt', data.receiptDate, company.fy_start_month);
      const account = ACCOUNT_FOR_MODE[data.mode];
      const journalId = await postJournal(c, {
        txnDate: data.receiptDate,
        sourceType: 'receipt',
        sourceId: id,
        narration: `Receipt ${number} for ${inv.number}`,
        lines: [
          { accountCode: account, debit: data.amount, projectId: inv.project_id },
          {
            accountCode: '1100',
            credit: data.amount,
            contactId: inv.client_id,
            projectId: inv.project_id,
          },
        ],
      });
      await c.query(
        `INSERT INTO receipt (id, company_id, number, receipt_date, client_id, project_id, amount, mode, reference,
                              received_by, account_code, journal_id, created_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, app_user_id())`,
        [
          id,
          number,
          data.receiptDate,
          inv.client_id,
          inv.project_id,
          toDecimalString(data.amount),
          data.mode,
          data.mode === 'cash' ? (data.reference ?? null) : data.reference,
          data.receivedBy ?? null,
          account,
          journalId,
        ],
      );
      await c.query(
        `INSERT INTO receipt_allocation (company_id, receipt_id, invoice_id, amount) VALUES (app_company_id(), $1, $2, $3)`,
        [id, data.invoiceId, toDecimalString(data.amount)],
      );
      await writeAudit(c, {
        action: 'create',
        entity: 'receipt',
        entityId: id,
        after: { number, ...data },
      });
      return { id, number };
    });
  }

  /** Deletes a receipt (`receipts = full`, open period): its journal is reversed; the row stays. */
  async remove(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Receipt');
    authorize(actor, 'receipts', 'full');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{
        number: string;
        project_id: string;
        journal_id: string;
        receipt_date: string;
        deleted_at: Date | null;
      }>(
        `SELECT number, project_id, journal_id, to_char(receipt_date, 'YYYY-MM-DD') AS receipt_date, deleted_at
           FROM receipt WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const r = rows[0];
      if (!r || !can(actor, 'receipts', 'view', r.project_id))
        throw new DomainError('NOT_FOUND', 'Receipt not found.');
      authorize(actor, 'receipts', 'full', r.project_id);
      if (r.deleted_at) throw new DomainError('CONFLICT', 'This receipt is already deleted.');
      const reversal = await reverseJournal(
        c,
        r.journal_id,
        r.receipt_date,
        `Receipt ${r.number} deleted`,
      );
      await c.query(
        `UPDATE receipt SET deleted_at = now(), deleted_by = app_user_id(), reversal_journal_id = $2 WHERE id = $1`,
        [id, reversal],
      );
      await writeAudit(c, {
        action: 'delete',
        entity: 'receipt',
        entityId: id,
        before: { number: r.number },
      });
    });
  }
}

/** Date, balance and lock-date checks for a new receipt; returns the company settings. */
async function checkReceipt(
  c: pg.PoolClient,
  data: { receiptDate: string; amount: Paise },
  inv: { invoice_date: string; balance: string },
): Promise<{ lock_date: string | null; fy_start_month: number }> {
  if (data.receiptDate < inv.invoice_date) {
    throw new DomainError(
      'VALIDATION',
      'The receipt cannot be dated before the invoice.',
      'receiptDate',
    );
  }
  const balance = fromDecimalString(inv.balance);
  if (data.amount > balance) {
    throw new DomainError(
      'VALIDATION',
      `The amount is more than the balance due (${formatInr(balance)}).`,
      'amount',
    );
  }
  const { rows } = await c.query<{ lock_date: string | null; fy_start_month: number }>(
    `SELECT to_char(lock_date, 'YYYY-MM-DD') AS lock_date, fy_start_month FROM company`,
  );
  const company = rows[0];
  if (!company) throw new DomainError('NOT_FOUND', 'Company not found.');
  assertNotLocked(data.receiptDate, company.lock_date, 'receiptDate');
  return company;
}

async function openInvoice(c: pg.PoolClient, actor: Actor, invoiceId: string) {
  // Lock the invoice FIRST, in its own statement. The balance must be read by a later statement:
  // under READ COMMITTED a subquery in the locking statement would still see the snapshot taken
  // before the lock wait, letting concurrent receipts overpay the invoice.
  await c.query('SELECT 1 FROM invoice WHERE id = $1 FOR UPDATE', [invoiceId]);
  const { rows } = await c.query<{
    number: string;
    project_id: string;
    client_id: string;
    status: string;
    invoice_date: string;
    balance: string;
  }>(
    `SELECT i.number, i.project_id, i.client_id, i.status, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
            b.balance::text AS balance
       FROM invoice i JOIN invoice_balance b ON b.invoice_id = i.id WHERE i.id = $1`,
    [invoiceId],
  );
  const inv = rows[0];
  if (!inv || !can(actor, 'receipts', 'view', inv.project_id))
    throw new DomainError('NOT_FOUND', 'Invoice not found.');
  authorize(actor, 'receipts', 'edit', inv.project_id);
  if (inv.status === 'cancelled')
    throw new DomainError('VALIDATION', 'This invoice is cancelled.', 'invoiceId');
  if (fromDecimalString(inv.balance) <= 0)
    throw new DomainError('VALIDATION', 'This invoice is already paid.', 'invoiceId');
  return inv;
}
