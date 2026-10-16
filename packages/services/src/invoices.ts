import { randomUUID } from 'node:crypto';
import {
  DomainError,
  assertId,
  assertNotLocked,
  authorize,
  can,
  computeDocument,
  financialYear,
  fromDecimalString,
  invoiceStatus,
  parseIsoDate,
  projectScope,
  toDecimalString,
  todayIn,
  type Actor,
  type DocumentTotals,
  type InvoiceStatus,
  type IsoDate,
  type LineInput,
  type Paise,
} from '@csd/core';
import {
  allocateNumber,
  postJournal,
  reverseJournal,
  withTenant,
  writeAudit,
  type JournalLineInput,
} from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { parse, tenantOf as ctx } from './validation.js';

const isoDate = z.string().refine((d) => {
  try {
    parseIsoDate(d);
    return true;
  } catch {
    return false;
  }
}, 'Enter a valid date.');

export const lineSchema = z.object({
  description: z.string().trim().min(1, 'Describe every line.').max(500),
  sacHsn: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'SAC/HSN must be 4–8 digits.')
    .default('9954'),
  qtyMilli: z.number().int().positive('Quantity must be more than zero.'),
  unit: z.string().trim().min(1).max(20).default('nos'),
  rate: z.number().int('Rate must be in paise.').min(0),
  gstRate: z.number().default(18),
});

const invoiceSchema = z.object({
  projectId: z.string().uuid('Choose a project.'),
  invoiceDate: isoDate,
  dueDate: isoDate,
  lines: z.array(lineSchema).min(1, 'Add at least one line.').max(200),
  notes: z.string().trim().max(2000).nullable().optional(),
});
const updateSchema = invoiceSchema
  .omit({ projectId: true })
  .extend({ version: z.number().int().positive() });
const cancelSchema = z.object({
  cnDate: isoDate,
  reason: z.string().trim().min(3, 'Give a reason.').max(500),
});

export type InvoiceInput = z.input<typeof invoiceSchema>;
export type InvoiceUpdate = z.input<typeof updateSchema>;
export type InvoiceLineInput = z.input<typeof lineSchema>;

export interface InvoiceSummary {
  id: string;
  number: string;
  invoiceDate: IsoDate;
  dueDate: IsoDate;
  clientId: string;
  clientName: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  interState: boolean;
  total: Paise;
  received: Paise;
  balance: Paise;
  status: InvoiceStatus;
}

export interface InvoiceLine {
  description: string;
  sacHsn: string;
  qtyMilli: number;
  unit: string;
  rate: Paise;
  gstRate: number;
  amount: Paise;
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
}

export interface InvoiceDetail extends InvoiceSummary {
  version: number;
  clientGstin: string | null;
  clientAddress: string | null;
  placeOfSupply: string;
  subtotal: Paise;
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  roundOff: Paise;
  notes: string | null;
  lines: InvoiceLine[];
  receipts: {
    id: string;
    number: string;
    date: IsoDate;
    amount: Paise;
    mode: string;
    reference: string | null;
  }[];
  creditNote: { number: string; date: IsoDate; reason: string } | null;
}

const SUMMARY = `
  SELECT i.id, i.number, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
         to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.client_id, i.client_name, i.project_id,
         p.code AS project_code, p.name AS project_name, i.is_inter_state, i.status, i.total::text,
         b.received::text, b.balance::text
    FROM invoice i
    JOIN project p ON p.id = i.project_id
    JOIN invoice_balance b ON b.invoice_id = i.id`;

interface SummaryRow {
  id: string;
  number: string;
  invoice_date: string;
  due_date: string;
  client_id: string;
  client_name: string;
  project_id: string;
  project_code: string;
  project_name: string;
  is_inter_state: boolean;
  status: 'issued' | 'cancelled';
  total: string;
  received: string;
  balance: string;
}

function toSummary(r: SummaryRow, today: IsoDate): InvoiceSummary {
  const total = fromDecimalString(r.total);
  const balance = fromDecimalString(r.balance);
  return {
    id: r.id,
    number: r.number,
    invoiceDate: r.invoice_date,
    dueDate: r.due_date,
    clientId: r.client_id,
    clientName: r.client_name,
    projectId: r.project_id,
    projectCode: r.project_code,
    projectName: r.project_name,
    interState: r.is_inter_state,
    total,
    received: fromDecimalString(r.received),
    balance,
    status: invoiceStatus(
      { cancelled: r.status === 'cancelled', total, balance, dueDate: r.due_date },
      today,
    ),
  };
}

/** Sales journal (Tech Spec §3): Dr receivable / Cr sales + output GST, round-off either side. */
export function invoiceJournalLines(
  t: DocumentTotals,
  clientId: string,
  projectId: string,
): JournalLineInput[] {
  const lines: JournalLineInput[] = [
    { accountCode: '1100', debit: t.total, contactId: clientId, projectId },
    { accountCode: '4000', credit: t.taxable, projectId },
  ];
  if (t.cgst) lines.push({ accountCode: '2200', credit: t.cgst, projectId });
  if (t.sgst) lines.push({ accountCode: '2201', credit: t.sgst, projectId });
  if (t.igst) lines.push({ accountCode: '2202', credit: t.igst, projectId });
  if (t.roundOff > 0) lines.push({ accountCode: '4900', credit: t.roundOff, projectId });
  if (t.roundOff < 0) lines.push({ accountCode: '4900', debit: -t.roundOff, projectId });
  return lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
}

interface LineRow {
  description: string;
  sac_hsn: string;
  qty_milli: string;
  unit: string;
  rate: string;
  gst_rate: string;
  amount: string;
  discount: string;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
}

function toLine(l: LineRow): InvoiceLine {
  const p = fromDecimalString;
  return {
    description: l.description,
    sacHsn: l.sac_hsn,
    qtyMilli: Number(l.qty_milli),
    unit: l.unit,
    rate: p(l.rate),
    gstRate: Number(l.gst_rate),
    amount: p(l.amount),
    discount: p(l.discount),
    taxable: p(l.taxable),
    cgst: p(l.cgst),
    sgst: p(l.sgst),
    igst: p(l.igst),
  };
}

async function journalOf(c: pg.PoolClient, invoiceId: string): Promise<string> {
  const { rows } = await c.query<{ journal_id: string }>(
    'SELECT journal_id FROM invoice WHERE id = $1',
    [invoiceId],
  );
  const id = rows[0]?.journal_id;
  if (!id) throw new DomainError('NOT_FOUND', 'Invoice not found.');
  return id;
}

function toLines(lines: z.output<typeof lineSchema>[]): LineInput[] {
  return lines.map((l) => ({ ...l }));
}

/** Tax invoices and credit notes (Req §5, FR-3.3.4, UAT 4/5). */
export class InvoicesService {
  constructor(private readonly pool: pg.Pool) {}

  async list(
    actor: Actor,
    filter: { projectId?: string | undefined; status?: InvoiceStatus | undefined } = {},
  ): Promise<InvoiceSummary[]> {
    authorize(actor, 'invoices', 'view');
    const scope = projectScope(actor);
    const today = todayIn();
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<SummaryRow>(
        `${SUMMARY}
          WHERE ($1::uuid[] IS NULL OR i.project_id = ANY($1::uuid[])) AND ($2::uuid IS NULL OR i.project_id = $2)
          ORDER BY i.invoice_date DESC, i.number DESC LIMIT 500`,
        [scope, filter.projectId ?? null],
      );
      const all = rows.map((r) => toSummary(r, today));
      return filter.status ? all.filter((i) => i.status === filter.status) : all;
    });
  }

  async get(actor: Actor, id: string): Promise<InvoiceDetail> {
    authorize(actor, 'invoices', 'view');
    assertId(id, 'Invoice');
    return withTenant(this.pool, ctx(actor), (c) => this.load(c, actor, id));
  }

  /** Issues a tax invoice: gapless CSD/FY/#### and its journal in one transaction. */
  async create(actor: Actor, input: InvoiceInput): Promise<{ id: string; number: string }> {
    const data = parse(invoiceSchema, input);
    authorize(actor, 'invoices', 'edit');
    assertProjectInScope(actor, data.projectId);
    assertDates(data.invoiceDate, data.dueDate);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const company = await companyRow(c);
      assertNotLocked(data.invoiceDate, company.lock_date, 'invoiceDate');
      const party = await billTo(c, data.projectId);
      const totals = computeDocument(toLines(data.lines), { placeOfSupply: party.state_code });
      const id = randomUUID();
      const number = await allocateNumber(c, 'invoice', data.invoiceDate, company.fy_start_month);
      const journalId = await postJournal(c, {
        txnDate: data.invoiceDate,
        sourceType: 'invoice',
        sourceId: id,
        narration: `Tax invoice ${number}`,
        lines: invoiceJournalLines(totals, party.client_id, data.projectId),
      });
      await c.query(
        `INSERT INTO invoice (id, company_id, number, fy, project_id, client_id, client_name, client_gstin, client_address,
                              place_of_supply, is_inter_state, invoice_date, due_date, subtotal, discount, taxable, cgst,
                              sgst, igst, round_off, total, notes, journal_id, created_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
                 $20, $21, $22, app_user_id())`,
        [
          id,
          number,
          financialYear(data.invoiceDate, company.fy_start_month),
          data.projectId,
          party.client_id,
          party.name,
          party.gstin,
          party.address,
          party.state_code,
          totals.interState,
          data.invoiceDate,
          data.dueDate,
          ...money(totals),
          data.notes ?? null,
          journalId,
        ],
      );
      await insertLines(c, id, data.lines, totals);
      await writeAudit(c, {
        action: 'create',
        entity: 'invoice',
        entityId: id,
        after: { number, ...data, total: totals.total },
      });
      return { id, number };
    });
  }

  /**
   * Edits an invoice that has no receipts (README §5): the old journal is reversed and a new one
   * posted, so posted entries are never changed. The number and financial year stay the same.
   */
  async update(actor: Actor, id: string, input: InvoiceUpdate): Promise<void> {
    assertId(id, 'Invoice');
    const data = parse(updateSchema, input);
    authorize(actor, 'invoices', 'edit');
    assertDates(data.invoiceDate, data.dueDate);
    await withTenant(this.pool, ctx(actor), async (c) => {
      const before = await this.load(c, actor, id, true);
      authorize(actor, 'invoices', 'edit', before.projectId);
      const company = await companyRow(c);
      if (before.version !== data.version) {
        throw new DomainError(
          'CONFLICT',
          'This invoice was changed by someone else. Reload it and try again.',
        );
      }
      if (before.status === 'cancelled')
        throw new DomainError('CONFLICT', 'A cancelled invoice cannot be edited.');
      if (before.received > 0)
        throw new DomainError('CONFLICT', 'An invoice with receipts cannot be edited.');
      if (
        financialYear(data.invoiceDate, company.fy_start_month) !==
        financialYear(before.invoiceDate, company.fy_start_month)
      ) {
        throw new DomainError(
          'VALIDATION',
          'The invoice date must stay in the same financial year.',
          'invoiceDate',
        );
      }
      assertNotLocked(before.invoiceDate, company.lock_date, 'invoiceDate');
      assertNotLocked(data.invoiceDate, company.lock_date, 'invoiceDate');
      const totals = computeDocument(toLines(data.lines), { placeOfSupply: before.placeOfSupply });
      await reverseJournal(
        c,
        await journalOf(c, id),
        before.invoiceDate,
        `Edit of ${before.number}: reversal`,
      );
      const journalId = await postJournal(c, {
        txnDate: data.invoiceDate,
        sourceType: 'invoice',
        sourceId: id,
        narration: `Tax invoice ${before.number} (edited)`,
        lines: invoiceJournalLines(totals, before.clientId, before.projectId),
      });
      await c.query(
        `UPDATE invoice SET invoice_date = $2, due_date = $3, subtotal = $4, discount = $5, taxable = $6, cgst = $7,
                sgst = $8, igst = $9, round_off = $10, total = $11, notes = $12, journal_id = $13, version = version + 1
          WHERE id = $1`,
        [id, data.invoiceDate, data.dueDate, ...money(totals), data.notes ?? null, journalId],
      );
      await c.query('DELETE FROM invoice_line WHERE invoice_id = $1', [id]);
      await insertLines(c, id, data.lines, totals);
      const after = await this.load(c, actor, id);
      await writeAudit(c, { action: 'update', entity: 'invoice', entityId: id, before, after });
    });
  }

  /** Cancels with a credit note CN/FY/#### (invoices are never deleted). Needs `invoices = full`. */
  async cancel(
    actor: Actor,
    id: string,
    input: z.input<typeof cancelSchema>,
  ): Promise<{ creditNote: string }> {
    assertId(id, 'Invoice');
    const data = parse(cancelSchema, input);
    authorize(actor, 'invoices', 'full');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const inv = await this.load(c, actor, id, true);
      authorize(actor, 'invoices', 'full', inv.projectId);
      if (inv.status === 'cancelled')
        throw new DomainError('CONFLICT', 'This invoice is already cancelled.');
      if (inv.received > 0)
        throw new DomainError('CONFLICT', 'Delete its receipts before cancelling this invoice.');
      if (data.cnDate < inv.invoiceDate) {
        throw new DomainError(
          'VALIDATION',
          'The credit note cannot be dated before the invoice.',
          'cnDate',
        );
      }
      if (data.cnDate > todayIn())
        throw new DomainError(
          'VALIDATION',
          'The credit note date cannot be in the future.',
          'cnDate',
        );
      const company = await companyRow(c);
      assertNotLocked(data.cnDate, company.lock_date, 'cnDate');
      const number = await allocateNumber(c, 'creditNote', data.cnDate, company.fy_start_month);
      const journalId = await reverseJournal(
        c,
        await journalOf(c, id),
        data.cnDate,
        `Credit note ${number} for ${inv.number}`,
      );
      await c.query(
        `INSERT INTO credit_note (company_id, number, invoice_id, cn_date, reason, taxable, cgst, sgst, igst, round_off,
                                  total, journal_id, created_by)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, app_user_id())`,
        [
          number,
          id,
          data.cnDate,
          data.reason,
          ...[inv.taxable, inv.cgst, inv.sgst, inv.igst, inv.roundOff, inv.total].map(
            toDecimalString,
          ),
          journalId,
        ],
      );
      // The invoice row keeps its (possibly now locked) date; only its status changes.
      await c.query(
        `UPDATE invoice SET status = 'cancelled', version = version + 1 WHERE id = $1`,
        [id],
      );
      await writeAudit(c, {
        action: 'cancel',
        entity: 'invoice',
        entityId: id,
        after: { creditNote: number, ...data },
      });
      return { creditNote: number };
    });
  }

  private async load(
    c: pg.PoolClient,
    actor: Actor,
    id: string,
    forUpdate = false,
  ): Promise<InvoiceDetail> {
    // Lock first, then read: concurrent edits/cancels see each other's committed state.
    if (forUpdate) await c.query('SELECT 1 FROM invoice WHERE id = $1 FOR UPDATE', [id]);
    const head = await c.query<
      SummaryRow & {
        version: number;
        client_gstin: string | null;
        client_address: string | null;
        place_of_supply: string;
        subtotal: string;
        discount: string;
        taxable: string;
        cgst: string;
        sgst: string;
        igst: string;
        round_off: string;
        notes: string | null;
      }
    >(
      `${SUMMARY.replace(
        'SELECT i.id,',
        `SELECT i.version, i.client_gstin, i.client_address, i.place_of_supply,
         i.subtotal::text, i.discount::text, i.taxable::text, i.cgst::text, i.sgst::text, i.igst::text,
         i.round_off::text, i.notes, i.id,`,
      )} WHERE i.id = $1`,
      [id],
    );
    const r = head.rows[0];
    // Out-of-scope invoices are not found (FR-2.4.2), whatever the rights.
    if (!r || !can(actor, 'invoices', 'view', r.project_id))
      throw new DomainError('NOT_FOUND', 'Invoice not found.');
    // One connection runs one query at a time (pg deprecates overlapping queries).
    const lines = await c.query<LineRow>(
      `SELECT description, sac_hsn, (qty * 1000)::bigint::text AS qty_milli, unit, rate::text, gst_rate::text,
                amount::text, discount::text, taxable::text, cgst::text, sgst::text, igst::text
           FROM invoice_line WHERE invoice_id = $1 ORDER BY sort`,
      [id],
    );
    const receipts = await c.query<{
      id: string;
      number: string;
      date: string;
      amount: string;
      mode: string;
      reference: string | null;
    }>(
      `SELECT r.id, r.number, to_char(r.receipt_date, 'YYYY-MM-DD') AS date, a.amount::text, r.mode, r.reference
           FROM receipt_allocation a JOIN receipt r ON r.id = a.receipt_id
          WHERE a.invoice_id = $1 AND r.deleted_at IS NULL ORDER BY r.receipt_date, r.number`,
      [id],
    );
    const cn = await c.query<{ number: string; date: string; reason: string }>(
      `SELECT number, to_char(cn_date, 'YYYY-MM-DD') AS date, reason FROM credit_note WHERE invoice_id = $1`,
      [id],
    );
    const p = fromDecimalString;
    return {
      ...toSummary(r, todayIn()),
      version: r.version,
      clientGstin: r.client_gstin,
      clientAddress: r.client_address,
      placeOfSupply: r.place_of_supply,
      subtotal: p(r.subtotal),
      discount: p(r.discount),
      taxable: p(r.taxable),
      cgst: p(r.cgst),
      sgst: p(r.sgst),
      igst: p(r.igst),
      roundOff: p(r.round_off),
      notes: r.notes,
      lines: lines.rows.map(toLine),
      receipts: receipts.rows.map((x) => ({ ...x, amount: p(x.amount) })),
      creditNote: cn.rows[0] ?? null,
    };
  }
}

function assertProjectInScope(actor: Actor, projectId: string): void {
  if (!can(actor, 'invoices', 'view', projectId))
    throw new DomainError('NOT_FOUND', 'Project not found.');
  authorize(actor, 'invoices', 'edit', projectId);
}

/** A tax invoice is dated today or earlier; the due date is on or after it. */
function assertDates(invoiceDate: IsoDate, dueDate: IsoDate): void {
  if (invoiceDate > todayIn()) {
    throw new DomainError(
      'VALIDATION',
      'A tax invoice cannot be dated in the future.',
      'invoiceDate',
    );
  }
  if (dueDate < invoiceDate)
    throw new DomainError(
      'VALIDATION',
      'The due date cannot be before the invoice date.',
      'dueDate',
    );
}

async function companyRow(
  c: pg.PoolClient,
): Promise<{ lock_date: string | null; fy_start_month: number }> {
  const { rows } = await c.query<{ lock_date: string | null; fy_start_month: number }>(
    `SELECT to_char(lock_date, 'YYYY-MM-DD') AS lock_date, fy_start_month FROM company`,
  );
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Company not found.');
  return rows[0];
}

/** The project's client, as it stands now: snapshotted onto the invoice. */
async function billTo(c: pg.PoolClient, projectId: string) {
  const { rows } = await c.query<{
    client_id: string;
    name: string;
    gstin: string | null;
    address: string | null;
    state_code: string;
    status: string;
  }>(
    `SELECT p.client_id, k.name, k.gstin, k.address, k.state_code, p.status
       FROM project p JOIN contact k ON k.id = p.client_id WHERE p.id = $1 FOR SHARE OF p`,
    [projectId],
  );
  const r = rows[0];
  if (!r) throw new DomainError('NOT_FOUND', 'Project not found.');
  if (r.status === 'cancelled')
    throw new DomainError('VALIDATION', 'This project is cancelled.', 'projectId');
  return r;
}

function money(t: DocumentTotals): string[] {
  return [t.subtotal, t.discount, t.taxable, t.cgst, t.sgst, t.igst, t.roundOff, t.total].map(
    toDecimalString,
  );
}

async function insertLines(
  c: pg.PoolClient,
  invoiceId: string,
  lines: z.output<typeof lineSchema>[],
  totals: DocumentTotals,
): Promise<void> {
  for (const [i, l] of lines.entries()) {
    const t = totals.lines[i];
    if (!t) throw new Error('line totals missing');
    await c.query(
      `INSERT INTO invoice_line (company_id, invoice_id, sort, description, sac_hsn, qty, unit, rate, gst_rate, amount,
                                 discount, taxable, cgst, sgst, igst)
       VALUES (app_company_id(), $1, $2, $3, $4, $5::numeric / 1000, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        invoiceId,
        i + 1,
        l.description,
        l.sacHsn,
        l.qtyMilli,
        l.unit,
        toDecimalString(l.rate),
        l.gstRate,
        ...[t.amount, t.discount, t.taxable, t.cgst, t.sgst, t.igst].map(toDecimalString),
      ],
    );
  }
}
