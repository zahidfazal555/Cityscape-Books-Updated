import { randomUUID } from 'node:crypto';
import {
  ACCOUNT_FOR_MODE,
  DomainError,
  assertId,
  assertNotLocked,
  authorize,
  can,
  formatInr,
  fromDecimalString,
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
import { companyRow, isoDate, parse, tenantOf as ctx, type CompanyRow } from './validation.js';

export const RECEIPT_MODES = ['bank', 'upi', 'cash', 'cheque'] as const;
export type ReceiptMode = (typeof RECEIPT_MODES)[number];

const receiptSchema = z
  .object({
    /** Exactly one: an invoice (payment) or a proforma (advance, Req FR-6.4). */
    invoiceId: z.string().uuid('Choose an invoice.').optional(),
    proformaId: z.string().uuid('Choose a proforma.').optional(),
    receiptDate: isoDate,
    amount: z.number().int('Amount must be in paise.').positive('Amount must be more than zero.'),
    mode: z.enum(RECEIPT_MODES),
    reference: z.string().trim().max(100).nullable().optional(),
    receivedBy: z.string().trim().max(80).nullable().optional(),
  })
  .refine((r) => (r.invoiceId === undefined) !== (r.proformaId === undefined), {
    message: 'Choose an invoice or a proforma.',
    path: ['invoiceId'],
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
  /** Set for an advance received against a proforma. */
  proformaNumber: string | null;
  /** An advance already moved onto its tax invoice: it cannot be deleted. */
  applied: boolean;
  amount: Paise;
  mode: ReceiptMode;
  reference: string | null;
  receivedBy: string | null;
}

/**
 * Client receipts (Req §6): against an open invoice or, as an advance, an open proforma;
 * amount ≤ balance; reference unless cash.
 */
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
        proforma_number: string | null;
        applied: boolean;
        amount: string;
        mode: ReceiptMode;
        reference: string | null;
        received_by: string | null;
      }>(
        `SELECT r.id, r.number, to_char(r.receipt_date, 'YYYY-MM-DD') AS receipt_date, k.name AS client_name, r.project_id,
                p.code AS project_code,
                (SELECT string_agg(i.number, ', ') FROM receipt_allocation a JOIN invoice i ON i.id = a.invoice_id
                  WHERE a.receipt_id = r.id) AS invoice_number,
                (SELECT string_agg(f.number, ', ') FROM receipt_allocation a JOIN proforma f ON f.id = a.proforma_id
                  WHERE a.receipt_id = r.id) AS proforma_number,
                EXISTS (SELECT 1 FROM receipt_allocation a WHERE a.receipt_id = r.id AND a.applied_at IS NOT NULL)
                  AS applied,
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
        proformaNumber: r.proforma_number,
        applied: r.applied,
        amount: fromDecimalString(r.amount),
        mode: r.mode,
        reference: r.reference,
        receivedBy: r.received_by,
      }));
    });
  }

  /** Live receipts by mode, over every receipt in scope (not just the listed page). */
  async totalsByMode(actor: Actor): Promise<Record<ReceiptMode, Paise>> {
    authorize(actor, 'receipts', 'view');
    const scope = projectScope(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{ mode: ReceiptMode; total: string }>(
        `SELECT mode, sum(amount)::text AS total FROM receipt
          WHERE deleted_at IS NULL AND ($1::uuid[] IS NULL OR project_id = ANY($1::uuid[]))
          GROUP BY mode`,
        [scope],
      );
      const totals: Record<ReceiptMode, Paise> = { bank: 0, upi: 0, cash: 0, cheque: 0 };
      for (const r of rows) totals[r.mode] = fromDecimalString(r.total);
      return totals;
    });
  }

  /**
   * Records RCT/FY/####. Against an invoice: Dr cash/bank/UPI, Cr receivable. Against a proforma
   * (an advance): Dr cash/bank/UPI, Cr customer advances, never revenue (FR-6.1). The document
   * row is locked so two receipts can never together exceed its balance.
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
      const doc = data.proformaId
        ? await openProforma(c, actor, data.proformaId)
        : await openInvoice(c, actor, data.invoiceId ?? '');
      const company = await checkReceipt(c, data, doc);
      const id = randomUUID();
      const number = await allocateNumber(c, 'receipt', data.receiptDate, company.fy_start_month);
      const account = ACCOUNT_FOR_MODE[data.mode];
      const journalId = await postJournal(c, {
        txnDate: data.receiptDate,
        sourceType: 'receipt',
        sourceId: id,
        narration: data.proformaId
          ? `Advance ${number} against ${doc.number}`
          : `Receipt ${number} for ${doc.number}`,
        lines: [
          { accountCode: account, debit: data.amount, projectId: doc.project_id },
          {
            accountCode: data.proformaId ? '2100' : '1100',
            credit: data.amount,
            contactId: doc.client_id,
            projectId: doc.project_id,
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
          doc.client_id,
          doc.project_id,
          toDecimalString(data.amount),
          data.mode,
          data.reference || null,
          data.receivedBy ?? null,
          account,
          journalId,
        ],
      );
      await c.query(
        `INSERT INTO receipt_allocation (company_id, receipt_id, invoice_id, proforma_id, amount)
         VALUES (app_company_id(), $1, $2, $3, $4)`,
        [id, data.invoiceId ?? null, data.proformaId ?? null, toDecimalString(data.amount)],
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
      await lockParents(c, id);
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
      const applied = await c.query<{ number: string }>(
        `SELECT i.number FROM receipt_allocation a JOIN invoice i ON i.id = a.invoice_id
          WHERE a.receipt_id = $1 AND a.applied_at IS NOT NULL`,
        [id],
      );
      if (applied.rows[0]) {
        throw new DomainError(
          'CONFLICT',
          `This advance was applied to tax invoice ${applied.rows[0].number} and cannot be deleted.`,
        );
      }
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
  doc: OpenDocument,
): Promise<CompanyRow> {
  if (data.receiptDate < doc.doc_date) {
    throw new DomainError(
      'VALIDATION',
      `The receipt cannot be dated before the ${doc.kind}.`,
      'receiptDate',
    );
  }
  const balance = fromDecimalString(doc.balance);
  if (data.amount > balance) {
    throw new DomainError(
      'VALIDATION',
      `The amount is more than the balance due (${formatInr(balance)}).`,
      'amount',
    );
  }
  const company = await companyRow(c);
  assertNotLocked(data.receiptDate, company.lock_date, 'receiptDate');
  return company;
}

interface OpenDocument {
  kind: 'invoice' | 'proforma';
  number: string;
  project_id: string;
  client_id: string;
  doc_date: string;
  balance: string;
}

/**
 * Locks the invoice or proforma a receipt is allocated to, before the receipt itself. Recording
 * and converting lock in the same order (document, then receipt), so a delete can never slip
 * between a conversion reading the advances and applying them.
 */
async function lockParents(c: pg.PoolClient, receiptId: string): Promise<void> {
  await c.query(
    `SELECT 1 FROM proforma WHERE id IN (SELECT proforma_id FROM receipt_allocation WHERE receipt_id = $1)
        ORDER BY id FOR UPDATE`,
    [receiptId],
  );
  await c.query(
    `SELECT 1 FROM invoice WHERE id IN (SELECT invoice_id FROM receipt_allocation WHERE receipt_id = $1)
        ORDER BY id FOR UPDATE`,
    [receiptId],
  );
}

async function openProforma(
  c: pg.PoolClient,
  actor: Actor,
  proformaId: string,
): Promise<OpenDocument> {
  // Lock first, read the balance in a later statement (see openInvoice).
  await c.query('SELECT 1 FROM proforma WHERE id = $1 FOR UPDATE', [proformaId]);
  const { rows } = await c.query<Omit<OpenDocument, 'kind'> & { status: string }>(
    `SELECT f.number, f.project_id, f.client_id, f.status, to_char(f.pf_date, 'YYYY-MM-DD') AS doc_date,
            b.balance::text AS balance
       FROM proforma f JOIN proforma_balance b ON b.proforma_id = f.id WHERE f.id = $1`,
    [proformaId],
  );
  const pf = rows[0];
  if (!pf || !can(actor, 'receipts', 'view', pf.project_id))
    throw new DomainError('NOT_FOUND', 'Proforma not found.');
  authorize(actor, 'receipts', 'edit', pf.project_id);
  if (pf.status === 'cancelled')
    throw new DomainError('VALIDATION', 'This proforma is cancelled.', 'proformaId');
  if (pf.status === 'converted') {
    throw new DomainError(
      'VALIDATION',
      'This proforma is already converted; record the receipt against its tax invoice.',
      'proformaId',
    );
  }
  if (fromDecimalString(pf.balance) <= 0)
    throw new DomainError('VALIDATION', 'This proforma is already fully paid.', 'proformaId');
  return { kind: 'proforma', ...pf };
}

async function openInvoice(
  c: pg.PoolClient,
  actor: Actor,
  invoiceId: string,
): Promise<OpenDocument> {
  // Lock the invoice FIRST, in its own statement. The balance must be read by a later statement:
  // under READ COMMITTED a subquery in the locking statement would still see the snapshot taken
  // before the lock wait, letting concurrent receipts overpay the invoice.
  await c.query('SELECT 1 FROM invoice WHERE id = $1 FOR UPDATE', [invoiceId]);
  const { rows } = await c.query<{
    number: string;
    project_id: string;
    client_id: string;
    status: string;
    doc_date: string;
    balance: string;
  }>(
    `SELECT i.number, i.project_id, i.client_id, i.status, to_char(i.invoice_date, 'YYYY-MM-DD') AS doc_date,
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
  return { kind: 'invoice', ...inv };
}
