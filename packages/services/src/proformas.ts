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
  percentOf,
  projectScope,
  toDecimalString,
  todayIn,
  type Actor,
  type DocumentTotals,
  type IsoDate,
  type Paise,
} from '@csd/core';
import { allocateNumber, postJournal, withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { readDocLines, writeDocLines, type DocLine } from './doc-lines.js';
import { issueInvoiceTx, lineSchema } from './invoices.js';
import { acceptedProject, assertWithinQuote, quoteTotals } from './quotations.js';
import { companyRow, isoDate, parse, tenantOf as ctx, type CompanyRow } from './validation.js';

export const PROFORMA_STATUSES = [
  'draft',
  'sent',
  'partially_paid',
  'paid',
  'overdue',
  'converted',
  'cancelled',
] as const;
/** Stored: draft, sent, converted, cancelled. The rest are derived from advances and due date. */
export type ProformaStatus = (typeof PROFORMA_STATUSES)[number];

const proformaSchema = z.object({
  projectId: z.string().uuid('Choose a project.'),
  stage: z.string().trim().min(1, 'Name the stage (e.g. Advance 30%).').max(120),
  pfDate: isoDate,
  dueDate: isoDate,
  lines: z.array(lineSchema).min(1, 'Add at least one line.').max(200),
});
const updateSchema = proformaSchema
  .omit({ projectId: true })
  .extend({ version: z.number().int().positive() });
const fromQuoteSchema = z.object({
  /** Share of the quote's (discounted) taxable value: 30/40/50/100% in the UI (FR-5.6). */
  pct: z.number().int().min(1, 'Between 1 and 100%.').max(100, 'Between 1 and 100%.'),
  stage: z.string().trim().min(1).max(120).optional(),
  pfDate: isoDate,
  dueDate: isoDate,
});
const convertSchema = z.object({
  /** FR-6.5: dated today unless given. */
  invoiceDate: isoDate.optional(),
  dueDate: isoDate.optional(),
});

export type ProformaInput = z.input<typeof proformaSchema>;
export type ProformaUpdate = z.input<typeof updateSchema>;
export type FromQuoteInput = z.input<typeof fromQuoteSchema>;

export interface ProformaSummary {
  id: string;
  number: string;
  pfDate: IsoDate;
  dueDate: IsoDate;
  stage: string;
  clientId: string;
  clientName: string;
  projectId: string;
  projectCode: string;
  quotationId: string | null;
  total: Paise;
  advances: Paise;
  balance: Paise;
  status: ProformaStatus;
  invoiceId: string | null;
  invoiceNumber: string | null;
}

export interface ProformaDetail extends ProformaSummary {
  version: number;
  placeOfSupply: string;
  lines: DocLine[];
  totals: DocumentTotals;
  advanceReceipts: {
    id: string;
    number: string;
    date: IsoDate;
    amount: Paise;
    mode: string;
    applied: boolean;
  }[];
}

/** $1 = today. Status derived in SQL so filters apply before the LIMIT. */
const WITH_STATUS = `
  SELECT f.id, f.number, to_char(f.pf_date, 'YYYY-MM-DD') AS pf_date, to_char(f.due_date, 'YYYY-MM-DD') AS due_date,
         f.stage, f.client_id, k.name AS client_name, f.project_id, p.code AS project_code, f.quotation_id,
         f.total::text, b.advances::text, b.balance::text, f.invoice_id, i.number AS invoice_number,
         CASE WHEN f.status IN ('converted', 'cancelled') THEN f.status
              WHEN b.balance <= 0 THEN 'paid'
              WHEN f.status = 'sent' AND f.due_date < $1::date THEN 'overdue'
              WHEN b.advances > 0 THEN 'partially_paid'
              ELSE f.status END AS status
    FROM proforma f
    JOIN contact k ON k.id = f.client_id
    JOIN project p ON p.id = f.project_id
    JOIN proforma_balance b ON b.proforma_id = f.id
    LEFT JOIN invoice i ON i.id = f.invoice_id`;

interface SummaryRow {
  id: string;
  number: string;
  pf_date: string;
  due_date: string;
  stage: string;
  client_id: string;
  client_name: string;
  project_id: string;
  project_code: string;
  quotation_id: string | null;
  total: string;
  advances: string;
  balance: string;
  invoice_id: string | null;
  invoice_number: string | null;
  status: ProformaStatus;
}

const toSummary = (r: SummaryRow): ProformaSummary => ({
  id: r.id,
  number: r.number,
  pfDate: r.pf_date,
  dueDate: r.due_date,
  stage: r.stage,
  clientId: r.client_id,
  clientName: r.client_name,
  projectId: r.project_id,
  projectCode: r.project_code,
  quotationId: r.quotation_id,
  total: fromDecimalString(r.total),
  advances: fromDecimalString(r.advances),
  balance: fromDecimalString(r.balance),
  status: r.status,
  invoiceId: r.invoice_id,
  invoiceNumber: r.invoice_number,
});

/**
 * Proforma invoices (Req §4.6, FR-6.1–6.7, UAT 1). A proforma is a payment request, not a tax
 * invoice: it posts nothing. Advances against it are held as customer advances (a liability)
 * and move onto the tax invoice it converts into.
 */
export class ProformasService {
  constructor(private readonly pool: pg.Pool) {}

  async list(
    actor: Actor,
    filter: { status?: ProformaStatus | undefined; projectId?: string | undefined } = {},
  ): Promise<ProformaSummary[]> {
    authorize(actor, 'proformas', 'view');
    const scope = projectScope(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<SummaryRow>(
        `SELECT * FROM (${WITH_STATUS}) s
          WHERE ($2::uuid[] IS NULL OR s.project_id = ANY($2::uuid[]))
            AND ($3::text IS NULL OR s.status = $3) AND ($4::uuid IS NULL OR s.project_id = $4)
          ORDER BY s.pf_date DESC, s.number DESC LIMIT 500`,
        [todayIn(), scope, filter.status ?? null, filter.projectId ?? null],
      );
      return rows.map(toSummary);
    });
  }

  async get(actor: Actor, id: string): Promise<ProformaDetail> {
    assertId(id, 'Proforma');
    authorize(actor, 'proformas', 'view');
    return withTenant(this.pool, ctx(actor), (c) => this.load(c, actor, id));
  }

  /** PI/FY/#### (gapless), dated today or earlier in an open period. */
  async create(actor: Actor, input: ProformaInput): Promise<{ id: string; number: string }> {
    const data = parse(proformaSchema, input);
    assertProjectRights(actor, data.projectId);
    return withTenant(this.pool, ctx(actor), (c) => insertProforma(c, data, null));
  }

  /** FR-5.6: a stage proforma for `pct`% of an accepted quote, one line per GST rate and SAC. */
  async fromQuote(
    actor: Actor,
    quotationId: string,
    input: FromQuoteInput,
  ): Promise<{ id: string; number: string }> {
    assertId(quotationId, 'Quotation');
    const data = parse(fromQuoteSchema, input);
    authorize(actor, 'proformas', 'edit');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const q = await quoteForStage(c, actor, quotationId);
      const stage = data.stage ?? (data.pct === 100 ? 'Full value' : `Advance ${data.pct}%`);
      const lines = stageLines(q, data.pct, stage);
      await assertWithinQuote(
        c,
        { ...q, taxable: q.totals.taxable },
        lines.reduce((t, l) => t + l.rate, 0),
      );
      return insertProforma(
        c,
        { projectId: q.projectId, stage, pfDate: data.pfDate, dueDate: data.dueDate, lines },
        quotationId,
      );
    });
  }

  /** FR-6.6: edit only while no advance has been received. Number and FY stay the same. */
  async update(actor: Actor, id: string, input: ProformaUpdate): Promise<void> {
    assertId(id, 'Proforma');
    const data = parse(updateSchema, input);
    authorize(actor, 'proformas', 'edit');
    assertDates(data.pfDate, data.dueDate);
    await withTenant(this.pool, ctx(actor), async (c) => {
      const before = await this.load(c, actor, id, true);
      authorize(actor, 'proformas', 'edit', before.projectId);
      assertChangeable(before, 'edited');
      if (before.version !== data.version) {
        throw new DomainError(
          'CONFLICT',
          'This proforma was changed by someone else. Reload it and try again.',
        );
      }
      const company = await companyRow(c);
      if (
        financialYear(data.pfDate, company.fy_start_month) !==
        financialYear(before.pfDate, company.fy_start_month)
      ) {
        throw new DomainError(
          'VALIDATION',
          'The proforma date must stay in the same financial year.',
          'pfDate',
        );
      }
      assertNotLocked(before.pfDate, company.lock_date, 'pfDate');
      assertNotLocked(data.pfDate, company.lock_date, 'pfDate');
      const totals = proformaTotals(data.lines, before.placeOfSupply, company);
      await c.query(
        `UPDATE proforma SET stage = $2, pf_date = $3, due_date = $4, ${TOTALS_SET}, version = version + 1,
                updated_by = app_user_id()
          WHERE id = $1`,
        [id, data.stage, data.pfDate, data.dueDate, ...money(totals)],
      );
      await writeDocLines(c, 'proforma', id, data.lines);
      const after = await this.load(c, actor, id);
      await writeAudit(c, { action: 'update', entity: 'proforma', entityId: id, before, after });
    });
  }

  /** Draft → Sent. */
  async send(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Proforma');
    authorize(actor, 'proformas', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const pf = await this.load(c, actor, id, true);
      authorize(actor, 'proformas', 'edit', pf.projectId);
      if (pf.status !== 'draft') throw new DomainError('CONFLICT', 'Only a draft can be sent.');
      await c.query(
        `UPDATE proforma SET status = 'sent', version = version + 1, updated_by = app_user_id() WHERE id = $1`,
        [id],
      );
      await writeAudit(c, { action: 'send', entity: 'proforma', entityId: id });
    });
  }

  /** FR-6.6: cancel only while no advance has been received (`proformas = full`). Never deleted. */
  async cancel(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Proforma');
    authorize(actor, 'proformas', 'full');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const pf = await this.load(c, actor, id, true);
      authorize(actor, 'proformas', 'full', pf.projectId);
      assertChangeable(pf, 'cancelled');
      await c.query(
        `UPDATE proforma SET status = 'cancelled', version = version + 1, updated_by = app_user_id() WHERE id = $1`,
        [id],
      );
      await writeAudit(c, {
        action: 'cancel',
        entity: 'proforma',
        entityId: id,
        before: { number: pf.number, status: pf.status },
      });
    });
  }

  /**
   * FR-6.5: issues the next CSD/FY/#### with the same lines, moves every advance onto it
   * (Dr customer advances / Cr receivable, dated the invoice date) and marks the proforma
   * Converted. The invoice then shows the advances as received.
   */
  async convert(
    actor: Actor,
    id: string,
    input: z.input<typeof convertSchema> = {},
  ): Promise<{ invoiceId: string; invoiceNumber: string; advancesApplied: Paise }> {
    assertId(id, 'Proforma');
    const data = parse(convertSchema, input);
    authorize(actor, 'proformas', 'edit');
    authorize(actor, 'invoices', 'edit');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const pf = await this.load(c, actor, id, true);
      authorize(actor, 'proformas', 'edit', pf.projectId);
      authorize(actor, 'invoices', 'edit', pf.projectId);
      if (pf.status === 'converted' || pf.status === 'cancelled')
        throw new DomainError('CONFLICT', `This proforma is already ${pf.status}.`);
      const invoiceDate = data.invoiceDate ?? todayIn();
      if (invoiceDate < pf.pfDate) {
        throw new DomainError(
          'VALIDATION',
          'The invoice cannot be dated before the proforma.',
          'invoiceDate',
        );
      }
      // BUG-087: the invoice cannot predate the advances it absorbs.
      const latest = pf.advanceReceipts.reduce((d, r) => (r.date > d ? r.date : d), '');
      if (invoiceDate < latest) {
        throw new DomainError(
          'VALIDATION',
          `The invoice cannot be dated before the last advance (${latest}).`,
          'invoiceDate',
        );
      }
      const inv = await issueInvoiceTx(c, {
        projectId: pf.projectId,
        invoiceDate,
        dueDate: data.dueDate,
        lines: pf.lines,
        quotationId: pf.quotationId,
        proformaId: id,
      });
      const applied = await applyAdvances(c, pf, inv, invoiceDate);
      await c.query(
        `UPDATE proforma SET status = 'converted', invoice_id = $2, converted_at = $3, advance_journal_id = $4,
                version = version + 1, updated_by = app_user_id()
          WHERE id = $1`,
        [id, inv.id, invoiceDate, applied.journalId],
      );
      await writeAudit(c, {
        action: 'convert',
        entity: 'proforma',
        entityId: id,
        after: { invoice: inv.number, advancesApplied: applied.amount },
      });
      return { invoiceId: inv.id, invoiceNumber: inv.number, advancesApplied: applied.amount };
    });
  }

  private async load(
    c: pg.PoolClient,
    actor: Actor,
    id: string,
    forUpdate = false,
  ): Promise<ProformaDetail> {
    // Lock first, then read: receipts and conversions see each other's committed advances.
    if (forUpdate) await c.query('SELECT 1 FROM proforma WHERE id = $1 FOR UPDATE', [id]);
    const head = await c.query<SummaryRow & { version: number; place_of_supply: string }>(
      `SELECT s.*, f.version, f.place_of_supply FROM (${WITH_STATUS}) s JOIN proforma f ON f.id = s.id
        WHERE s.id = $2`,
      [todayIn(), id],
    );
    const r = head.rows[0];
    if (!r || !can(actor, 'proformas', 'view', r.project_id))
      throw new DomainError('NOT_FOUND', 'Proforma not found.');
    const lines = await readDocLines(c, 'proforma', id);
    const company = await companyRow(c);
    const receipts = await c.query<{
      id: string;
      number: string;
      date: string;
      amount: string;
      mode: string;
      applied: boolean;
    }>(
      `SELECT r.id, r.number, to_char(r.receipt_date, 'YYYY-MM-DD') AS date, a.amount::text, r.mode,
              (a.applied_at IS NOT NULL) AS applied
         FROM receipt_allocation a JOIN receipt r ON r.id = a.receipt_id
        WHERE a.proforma_id = $1 AND r.deleted_at IS NULL ORDER BY r.receipt_date, r.number`,
      [id],
    );
    return {
      ...toSummary(r),
      version: r.version,
      placeOfSupply: r.place_of_supply,
      lines,
      totals: proformaTotals(lines, r.place_of_supply, company),
      advanceReceipts: receipts.rows.map((x) => ({ ...x, amount: fromDecimalString(x.amount) })),
    };
  }
}

const TOTALS_SET = 'taxable = $5, cgst = $6, sgst = $7, igst = $8, round_off = $9, total = $10';

function money(t: DocumentTotals): string[] {
  return [t.taxable, t.cgst, t.sgst, t.igst, t.roundOff, t.total].map(toDecimalString);
}

function proformaTotals(
  lines: readonly DocLine[],
  placeOfSupply: string,
  company: CompanyRow,
): DocumentTotals {
  const t = computeDocument(
    lines.map((l) => ({ ...l })),
    { placeOfSupply, companyStateCode: company.state_code },
  );
  if (t.total <= 0)
    throw new DomainError('VALIDATION', 'The proforma total must be more than zero.', 'lines');
  return t;
}

function assertProjectRights(actor: Actor, projectId: string): void {
  authorize(actor, 'proformas', 'edit');
  if (!can(actor, 'proformas', 'view', projectId))
    throw new DomainError('NOT_FOUND', 'Project not found.');
  authorize(actor, 'proformas', 'edit', projectId);
}

function assertDates(pfDate: IsoDate, dueDate: IsoDate): void {
  if (pfDate > todayIn())
    throw new DomainError('VALIDATION', 'A proforma cannot be dated in the future.', 'pfDate');
  if (dueDate < pfDate) {
    throw new DomainError(
      'VALIDATION',
      'The payment due date cannot be before the proforma date.',
      'dueDate',
    );
  }
}

function assertChangeable(pf: ProformaDetail, verb: 'edited' | 'cancelled'): void {
  if (pf.status === 'converted' || pf.status === 'cancelled')
    throw new DomainError('CONFLICT', `A ${pf.status} proforma cannot be ${verb}.`);
  if (pf.advances > 0) {
    throw new DomainError(
      'CONFLICT',
      `A proforma with advances received cannot be ${verb}. Delete the advance receipts first.`,
    );
  }
}

/** The project's client as it stands now; a cancelled project or archived client is refused. */
async function projectParty(
  c: pg.PoolClient,
  projectId: string,
): Promise<{ client_id: string; state_code: string }> {
  const { rows } = await c.query<{
    client_id: string;
    state_code: string;
    status: string;
    archived: boolean;
  }>(
    `SELECT p.client_id, k.state_code, p.status, (k.deleted_at IS NOT NULL) AS archived
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

async function insertProforma(
  c: pg.PoolClient,
  data: z.output<typeof proformaSchema>,
  quotationId: string | null,
): Promise<{ id: string; number: string }> {
  assertDates(data.pfDate, data.dueDate);
  const company = await companyRow(c);
  assertNotLocked(data.pfDate, company.lock_date, 'pfDate');
  const party = await projectParty(c, data.projectId);
  const totals = proformaTotals(data.lines, party.state_code, company);
  const id = randomUUID();
  const number = await allocateNumber(c, 'proforma', data.pfDate, company.fy_start_month);
  await c.query(
    `INSERT INTO proforma (id, company_id, number, project_id, client_id, quotation_id, stage, place_of_supply,
                           pf_date, due_date, taxable, cgst, sgst, igst, round_off, total, created_by, updated_by)
     VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             app_user_id(), app_user_id())`,
    [
      id,
      number,
      data.projectId,
      party.client_id,
      quotationId,
      data.stage,
      party.state_code,
      data.pfDate,
      data.dueDate,
      ...money(totals),
    ],
  );
  await writeDocLines(c, 'proforma', id, data.lines);
  await writeAudit(c, {
    action: 'create',
    entity: 'proforma',
    entityId: id,
    after: { number, ...data, quotationId, total: totals.total },
  });
  return { id, number };
}

interface StageQuote {
  id: string;
  number: string;
  title: string;
  projectId: string;
  lines: DocLine[];
  totals: DocumentTotals;
}

async function quoteForStage(c: pg.PoolClient, actor: Actor, id: string): Promise<StageQuote> {
  // FOR UPDATE: two stage proformas from one quote are checked against its value one at a time.
  const { rows } = await c.query<{
    number: string;
    title: string;
    status: string;
    project_id: string | null;
    discount_pct: string;
    place_of_supply: string;
  }>(
    `SELECT number, title, status, project_id, discount_pct::text, place_of_supply
       FROM quotation WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const q = rows[0];
  // BUG-088: not found before any status check, so an invisible quote is never confirmed.
  if (!q || !can(actor, 'quotes', 'view', q.project_id ?? undefined))
    throw new DomainError('NOT_FOUND', 'Quotation not found.');
  const projectId = acceptedProject({ status: q.status as 'accepted', projectId: q.project_id });
  if (!can(actor, 'proformas', 'view', projectId))
    throw new DomainError('NOT_FOUND', 'Project not found.');
  authorize(actor, 'proformas', 'edit', projectId);
  const lines = await readDocLines(c, 'quotation', id);
  const company = await companyRow(c);
  return {
    id,
    number: q.number,
    title: q.title,
    projectId,
    lines,
    totals: quoteTotals(lines, Number(q.discount_pct), q.place_of_supply, company.state_code),
  };
}

/**
 * `pct`% of the quote's taxable value after discount, one line per (GST rate, SAC) so the GST on
 * the proforma, and later on the advance (GSTR-1 Table 11A), follows the quote's mix of rates.
 */
export function stageLines(q: StageQuote, pct: number, stage: string): DocLine[] {
  const groups = new Map<string, { sacHsn: string; gstRate: number; taxable: Paise }>();
  q.lines.forEach((l, i) => {
    const key = `${l.gstRate}|${l.sacHsn}`;
    const g = groups.get(key) ?? { sacHsn: l.sacHsn, gstRate: l.gstRate, taxable: 0 };
    g.taxable += q.totals.lines[i]?.taxable ?? 0;
    groups.set(key, g);
  });
  const many = groups.size > 1;
  return [...groups.values()]
    .map((g) => ({
      description: `${stage} – ${pct}% of ${q.number} (${q.title})${many ? ` · GST ${g.gstRate}%` : ''}`,
      sacHsn: g.sacHsn,
      qtyMilli: 1000,
      unit: 'lot',
      rate: percentOf(g.taxable, pct),
      gstRate: g.gstRate,
    }))
    .filter((l) => l.rate > 0);
}

/**
 * Moves every live, unapplied advance onto the new invoice: the allocation row gets the
 * invoice and the application date (the proforma link is kept for history), and one journal
 * clears customer advances against the receivable.
 */
async function applyAdvances(
  c: pg.PoolClient,
  pf: ProformaDetail,
  inv: { id: string; number: string; totals: DocumentTotals },
  invoiceDate: IsoDate,
): Promise<{ amount: Paise; journalId: string | null }> {
  const { rows } = await c.query<{ id: string; amount: string }>(
    `SELECT a.id, a.amount::text FROM receipt_allocation a JOIN receipt r ON r.id = a.receipt_id
      WHERE a.proforma_id = $1 AND a.applied_at IS NULL AND r.deleted_at IS NULL
      ORDER BY a.id FOR UPDATE OF a`,
    [pf.id],
  );
  const amount = rows.reduce((s, r) => s + fromDecimalString(r.amount), 0);
  if (amount === 0) return { amount, journalId: null };
  if (amount > inv.totals.total) {
    throw new DomainError(
      'CONFLICT',
      'The advances received are more than the invoice total. Check the client’s state and lines.',
    );
  }
  await c.query(
    `UPDATE receipt_allocation SET invoice_id = $2, applied_at = $3 WHERE id = ANY($1::uuid[])`,
    [rows.map((r) => r.id), inv.id, invoiceDate],
  );
  const journalId = await postJournal(c, {
    txnDate: invoiceDate,
    sourceType: 'advance_applied',
    sourceId: pf.id,
    narration: `Advances on ${pf.number} applied to ${inv.number}`,
    lines: [
      { accountCode: '2100', debit: amount, contactId: pf.clientId, projectId: pf.projectId },
      { accountCode: '1100', credit: amount, contactId: pf.clientId, projectId: pf.projectId },
    ],
  });
  return { amount, journalId };
}
