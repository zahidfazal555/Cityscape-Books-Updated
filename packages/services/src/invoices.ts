import { randomUUID } from 'node:crypto';
import {
  DomainError,
  addDays,
  assertId,
  assertNotLocked,
  authorize,
  can,
  computeDocument,
  financialYear,
  fromDecimalString,
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
import {
  companyRow,
  isoDate,
  parse,
  pick,
  tenantOf as ctx,
  type CompanyRow,
} from './validation.js';

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
  /** Defaults to the client's payment terms, else 15 days (FR-7.1). */
  dueDate: isoDate.optional(),
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

export const DEFAULT_PAYMENT_DAYS = 15;

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

/**
 * Invoice rows with balance and a status derived in SQL (README §5), so list filters apply
 * before any LIMIT. $1 = today's business date.
 */
const WITH_STATUS = `
  SELECT i.id, i.number, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
         to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.client_id, i.client_name, i.project_id,
         p.code AS project_code, p.name AS project_name, i.is_inter_state, i.total::text,
         b.received::text, b.balance::text,
         CASE WHEN i.status = 'cancelled' THEN 'cancelled'
              WHEN b.balance <= 0 THEN 'paid'
              WHEN i.due_date < $1::date THEN 'overdue'
              WHEN b.balance < i.total THEN 'partially_paid'
              ELSE 'unpaid' END AS status
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
  total: string;
  received: string;
  balance: string;
  status: InvoiceStatus;
}

function toSummary(r: SummaryRow): InvoiceSummary {
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
    total: fromDecimalString(r.total),
    received: fromDecimalString(r.received),
    balance: fromDecimalString(r.balance),
    status: r.status,
  };
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

/** Totals for validated lines; a tax invoice must be worth something. */
function totalsFor(
  lines: z.output<typeof lineSchema>[],
  placeOfSupply: string,
  company: CompanyRow,
): DocumentTotals {
  const t = computeDocument(
    lines.map((l): LineInput => ({ ...l })),
    {
      placeOfSupply,
      companyStateCode: company.state_code,
    },
  );
  if (t.total <= 0)
    throw new DomainError('VALIDATION', 'The invoice total must be more than zero.', 'lines');
  return t;
}

export interface IssueInvoice {
  projectId: string;
  invoiceDate: IsoDate;
  dueDate?: IsoDate | undefined;
  lines: z.output<typeof lineSchema>[];
  notes?: string | null | undefined;
  quotationId?: string | null;
  proformaId?: string | null;
}

/**
 * Issues a tax invoice inside the caller's transaction (used by "New invoice" and by proforma
 * conversion). The caller has already checked rights and project scope.
 */
export async function issueInvoiceTx(
  c: pg.PoolClient,
  data: IssueInvoice,
): Promise<{ id: string; number: string; totals: DocumentTotals }> {
  assertNotFuture(data.invoiceDate);
  const company = await companyRow(c);
  assertNotLocked(data.invoiceDate, company.lock_date, 'invoiceDate');
  const party = await billTo(c, data.projectId);
  const dueDate =
    data.dueDate ?? addDays(data.invoiceDate, party.payment_terms_days ?? DEFAULT_PAYMENT_DAYS);
  assertDue(data.invoiceDate, dueDate);
  const totals = totalsFor(data.lines, party.state_code, company);
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
                            sgst, igst, round_off, total, notes, journal_id, quotation_id, proforma_id, created_by)
       VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $23, $24, app_user_id())`,
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
      dueDate,
      ...money(totals),
      data.notes ?? null,
      journalId,
      data.quotationId ?? null,
      data.proformaId ?? null,
    ],
  );
  await insertLines(c, id, data.lines, totals);
  await writeAudit(c, {
    action: 'create',
    entity: 'invoice',
    entityId: id,
    after: { number, ...data, dueDate, total: totals.total },
  });
  return { id, number, totals };
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
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<SummaryRow>(
        `SELECT * FROM (${WITH_STATUS}) s
          WHERE ($2::uuid[] IS NULL OR s.project_id = ANY($2::uuid[]))
            AND ($3::uuid IS NULL OR s.project_id = $3)
            AND ($4::text IS NULL OR s.status = $4)
          ORDER BY s.invoice_date DESC, s.number DESC LIMIT 500`,
        [todayIn(), scope, filter.projectId ?? null, filter.status ?? null],
      );
      return rows.map(toSummary);
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
    const { id, number } = await withTenant(this.pool, ctx(actor), (c) => issueInvoiceTx(c, data));
    return { id, number };
  }

  /**
   * Edits an invoice that has no receipts (README §5): the old journal is reversed and a new one
   * posted, so posted entries are never changed. Number and financial year stay the same. A due
   * date left out is recomputed from the (new) invoice date.
   */
  async update(actor: Actor, id: string, input: InvoiceUpdate): Promise<void> {
    assertId(id, 'Invoice');
    const data = parse(updateSchema, input);
    authorize(actor, 'invoices', 'edit');
    assertNotFuture(data.invoiceDate);
    await withTenant(this.pool, ctx(actor), async (c) => {
      const before = await this.load(c, actor, id, true);
      authorize(actor, 'invoices', 'edit', before.projectId);
      const company = await companyRow(c);
      assertEditable(before, data.version);
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
      const terms = await paymentTerms(c, before.clientId);
      const dueDate = data.dueDate ?? addDays(data.invoiceDate, terms);
      assertDue(data.invoiceDate, dueDate);
      const totals = totalsFor(data.lines, before.placeOfSupply, company);
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
        [
          id,
          data.invoiceDate,
          dueDate,
          ...money(totals),
          pick(data.notes, before.notes),
          journalId,
        ],
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
      if (data.cnDate > todayIn()) {
        throw new DomainError(
          'VALIDATION',
          'The credit note date cannot be in the future.',
          'cnDate',
        );
      }
      const company = await companyRow(c);
      assertNotLocked(data.cnDate, company.lock_date, 'cnDate');
      const cnId = randomUUID();
      const number = await allocateNumber(c, 'creditNote', data.cnDate, company.fy_start_month);
      // Tagged as its own document so journal-based reports can tell it from an edit reversal.
      const journalId = await reverseJournal(
        c,
        await journalOf(c, id),
        data.cnDate,
        `Credit note ${number} for ${inv.number}`,
        {
          sourceType: 'credit_note',
          sourceId: cnId,
        },
      );
      await c.query(
        `INSERT INTO credit_note (id, company_id, number, invoice_id, cn_date, reason, taxable, cgst, sgst, igst,
                                  round_off, total, journal_id, created_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, app_user_id())`,
        [
          cnId,
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
    const head = await c.query<SummaryRow & DetailColumns>(
      `SELECT s.*, i.version, i.client_gstin, i.client_address, i.place_of_supply, i.subtotal::text,
              i.discount::text, i.taxable::text, i.cgst::text, i.sgst::text, i.igst::text, i.round_off::text, i.notes
         FROM (${WITH_STATUS}) s JOIN invoice i ON i.id = s.id WHERE s.id = $2`,
      [todayIn(), id],
    );
    const r = head.rows[0];
    // Out-of-scope invoices are not found (FR-2.4.2), whatever the rights.
    if (!r || !can(actor, 'invoices', 'view', r.project_id))
      throw new DomainError('NOT_FOUND', 'Invoice not found.');
    return { ...toSummary(r), ...detailFields(r), ...(await children(c, id)) };
  }
}

interface DetailColumns {
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

function detailFields(r: DetailColumns) {
  const p = fromDecimalString;
  return {
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
  };
}

/** Lines, live receipts and the credit note. One connection runs one query at a time. */
async function children(
  c: pg.PoolClient,
  id: string,
): Promise<Pick<InvoiceDetail, 'lines' | 'receipts' | 'creditNote'>> {
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
  return {
    lines: lines.rows.map(toLine),
    receipts: receipts.rows.map((x) => ({ ...x, amount: fromDecimalString(x.amount) })),
    creditNote: cn.rows[0] ?? null,
  };
}

function assertEditable(inv: InvoiceDetail, version: number): void {
  if (inv.version !== version) {
    throw new DomainError(
      'CONFLICT',
      'This invoice was changed by someone else. Reload it and try again.',
    );
  }
  if (inv.status === 'cancelled')
    throw new DomainError('CONFLICT', 'A cancelled invoice cannot be edited.');
  if (inv.received > 0)
    throw new DomainError('CONFLICT', 'An invoice with receipts cannot be edited.');
}

function assertProjectInScope(actor: Actor, projectId: string): void {
  if (!can(actor, 'invoices', 'view', projectId))
    throw new DomainError('NOT_FOUND', 'Project not found.');
  authorize(actor, 'invoices', 'edit', projectId);
}

function assertNotFuture(invoiceDate: IsoDate): void {
  if (invoiceDate > todayIn()) {
    throw new DomainError(
      'VALIDATION',
      'A tax invoice cannot be dated in the future.',
      'invoiceDate',
    );
  }
}

function assertDue(invoiceDate: IsoDate, dueDate: IsoDate): void {
  if (dueDate < invoiceDate) {
    throw new DomainError(
      'VALIDATION',
      'The due date cannot be before the invoice date.',
      'dueDate',
    );
  }
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

async function paymentTerms(c: pg.PoolClient, clientId: string): Promise<number> {
  const { rows } = await c.query<{ days: number | null }>(
    'SELECT payment_terms_days AS days FROM contact WHERE id = $1',
    [clientId],
  );
  return rows[0]?.days ?? DEFAULT_PAYMENT_DAYS;
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
    payment_terms_days: number | null;
    archived: boolean;
  }>(
    `SELECT p.client_id, k.name, k.gstin, k.address, k.state_code, p.status, k.payment_terms_days,
            (k.deleted_at IS NOT NULL) AS archived
       FROM project p JOIN contact k ON k.id = p.client_id WHERE p.id = $1 FOR SHARE OF p`,
    [projectId],
  );
  const r = rows[0];
  if (!r) throw new DomainError('NOT_FOUND', 'Project not found.');
  if (r.status === 'cancelled')
    throw new DomainError('VALIDATION', 'This project is cancelled.', 'projectId');
  if (r.archived)
    throw new DomainError('VALIDATION', 'This project’s client is archived.', 'projectId');
  return r;
}

function money(t: DocumentTotals): string[] {
  return [t.subtotal, t.discount, t.taxable, t.cgst, t.sgst, t.igst, t.roundOff, t.total].map(
    toDecimalString,
  );
}

/** All lines in one statement: the gapless number-series row stays locked as briefly as possible. */
async function insertLines(
  c: pg.PoolClient,
  invoiceId: string,
  lines: z.output<typeof lineSchema>[],
  totals: DocumentTotals,
): Promise<void> {
  const col = <T>(
    f: (l: z.output<typeof lineSchema>, t: DocumentTotals['lines'][number], i: number) => T,
  ): T[] =>
    lines.map((l, i) => {
      const t = totals.lines[i];
      if (!t) throw new Error('line totals missing');
      return f(l, t, i);
    });
  const d = toDecimalString;
  await c.query(
    `INSERT INTO invoice_line (company_id, invoice_id, sort, description, sac_hsn, qty, unit, rate, gst_rate, amount,
                               discount, taxable, cgst, sgst, igst)
     SELECT app_company_id(), $1, sort, description, sac_hsn, qty_milli::numeric / 1000, unit, rate, gst_rate, amount,
            discount, taxable, cgst, sgst, igst
       FROM unnest($2::int[], $3::text[], $4::text[], $5::bigint[], $6::text[], $7::numeric[], $8::numeric[],
                   $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[], $14::numeric[])
         AS t(sort, description, sac_hsn, qty_milli, unit, rate, gst_rate, amount, discount, taxable, cgst, sgst, igst)`,
    [
      invoiceId,
      col((_l, _t, i) => i + 1),
      col((l) => l.description),
      col((l) => l.sacHsn),
      col((l) => l.qtyMilli),
      col((l) => l.unit),
      col((l) => d(l.rate)),
      col((l) => l.gstRate),
      col((_l, t) => d(t.amount)),
      col((_l, t) => d(t.discount)),
      col((_l, t) => d(t.taxable)),
      col((_l, t) => d(t.cgst)),
      col((_l, t) => d(t.sgst)),
      col((_l, t) => d(t.igst)),
    ],
  );
}
