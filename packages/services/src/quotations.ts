import { randomUUID } from 'node:crypto';
import {
  DomainError,
  assertId,
  authorize,
  can,
  computeDocument,
  formatInr,
  fromDecimalString,
  mulDivHalfUp,
  percentOf,
  projectScope,
  requiresApproval,
  toBasisPoints,
  toDecimalString,
  todayIn,
  type Actor,
  type DocumentTotals,
  type IsoDate,
  type Paise,
} from '@csd/core';
import { allocateNumber, withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { readDocLines, writeDocLines, type DocLine } from './doc-lines.js';
import { issueInvoiceTx, lineSchema } from './invoices.js';
import { createProjectTx, type Fields } from './projects.js';
import { companyRow, isoDate, parse, pick, tenantOf as ctx } from './validation.js';

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const;
/** `expired` is derived: a Sent quote past its valid-till date (FR-5.3). */
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

const discountPct = z
  .number()
  .min(0, 'Discount must be between 0 and 50%.')
  .max(50, 'Discount must be between 0 and 50%.')
  .refine((d) => Math.abs(d * 100 - Math.round(d * 100)) < 1e-6, 'At most 2 decimals.');

const quoteSchema = z.object({
  clientId: z.string().uuid('Choose a client.'),
  title: z.string().trim().min(1, 'Enter the proposal title.').max(200),
  site: z.string().trim().max(500).nullable().optional(),
  quoteDate: isoDate,
  validTill: isoDate,
  discountPct: discountPct.default(0),
  lines: z.array(lineSchema).min(1, 'Add at least one line.').max(200),
  terms: z.string().trim().max(4000).nullable().optional(),
});
const updateSchema = quoteSchema.extend({ version: z.number().int().positive() });
const acceptSchema = z.object({
  /** Link to an existing project of the same client (FR-5.7) instead of creating one. */
  projectId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(160).optional(),
  siteAddress: z.string().trim().max(500).nullable().optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.nullable().optional(),
  /** Defaults to 75% of the contract value (FR-5.5). */
  costBudget: z.number().int().min(0).max(99_999_999_999_999).optional(),
  managerId: z.string().uuid().nullable().optional(),
  engineerId: z.string().uuid().nullable().optional(),
});
const toInvoiceSchema = z.object({ invoiceDate: isoDate, dueDate: isoDate.optional() });

export type QuoteInput = z.input<typeof quoteSchema>;
export type QuoteUpdate = z.input<typeof updateSchema>;
export type AcceptInput = z.input<typeof acceptSchema>;

export const DEFAULT_BUDGET_PCT = 75;

export interface QuoteSummary {
  id: string;
  number: string;
  revision: number;
  clientId: string;
  clientName: string;
  title: string;
  quoteDate: IsoDate;
  validTill: IsoDate;
  status: QuoteStatus;
  discountPct: number;
  discountApproved: boolean;
  projectId: string | null;
  projectCode: string | null;
  taxable: Paise;
  total: Paise;
}

export interface QuoteRevision {
  revision: number;
  status: string;
  quoteDate: IsoDate;
  total: Paise;
  createdAt: string;
}

export interface QuoteDetail extends QuoteSummary {
  version: number;
  site: string | null;
  terms: string | null;
  placeOfSupply: string;
  lines: DocLine[];
  totals: DocumentTotals;
  revisions: QuoteRevision[];
  /** Documents raised from this quote. */
  proformas: { id: string; number: string; status: string; total: Paise }[];
  invoices: { id: string; number: string; total: Paise }[];
}

/** $1 = today. Status is derived in SQL so filters apply before the LIMIT. */
const WITH_STATUS = `
  SELECT q.id, q.number, q.revision, q.client_id, k.name AS client_name, q.title,
         to_char(q.quote_date, 'YYYY-MM-DD') AS quote_date, to_char(q.valid_till, 'YYYY-MM-DD') AS valid_till,
         CASE WHEN q.status = 'sent' AND q.valid_till < $1::date THEN 'expired' ELSE q.status END AS status,
         q.discount_pct::text, q.discount_approved, q.project_id, p.code AS project_code,
         q.taxable::text, q.total::text
    FROM quotation q JOIN contact k ON k.id = q.client_id LEFT JOIN project p ON p.id = q.project_id`;

interface SummaryRow {
  id: string;
  number: string;
  revision: number;
  client_id: string;
  client_name: string;
  title: string;
  quote_date: string;
  valid_till: string;
  status: QuoteStatus;
  discount_pct: string;
  discount_approved: boolean;
  project_id: string | null;
  project_code: string | null;
  taxable: string;
  total: string;
}

const toSummary = (r: SummaryRow): QuoteSummary => ({
  id: r.id,
  number: r.number,
  revision: r.revision,
  clientId: r.client_id,
  clientName: r.client_name,
  title: r.title,
  quoteDate: r.quote_date,
  validTill: r.valid_till,
  status: r.status,
  discountPct: Number(r.discount_pct),
  discountApproved: r.discount_approved,
  projectId: r.project_id,
  projectCode: r.project_code,
  taxable: fromDecimalString(r.taxable),
  total: fromDecimalString(r.total),
});

/**
 * A quote not yet linked to a project is visible to anyone with `quotes`; once linked it follows
 * the project's scope (FR-2.4.2), and out of scope it is not found.
 */
function visible(actor: Actor, projectId: string | null): boolean {
  return projectId === null
    ? can(actor, 'quotes', 'view')
    : can(actor, 'quotes', 'view', projectId);
}

/** Quotations with revisions (Req §4.5, FR-5.1–5.8, UAT 1). Quotes never post to the books. */
export class QuotationsService {
  constructor(private readonly pool: pg.Pool) {}

  async list(
    actor: Actor,
    filter: { status?: QuoteStatus | undefined } = {},
  ): Promise<QuoteSummary[]> {
    authorize(actor, 'quotes', 'view');
    const scope = projectScope(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<SummaryRow>(
        `SELECT * FROM (${WITH_STATUS}) s
          WHERE ($2::uuid[] IS NULL OR s.project_id IS NULL OR s.project_id = ANY($2::uuid[]))
            AND ($3::text IS NULL OR s.status = $3)
          ORDER BY s.quote_date DESC, s.number DESC LIMIT 500`,
        [todayIn(), scope, filter.status ?? null],
      );
      return rows.map(toSummary);
    });
  }

  async get(actor: Actor, id: string): Promise<QuoteDetail> {
    assertId(id, 'Quotation');
    authorize(actor, 'quotes', 'view');
    return withTenant(this.pool, ctx(actor), (c) => this.load(c, actor, id));
  }

  /** QT/FY/#### at revision 0, status Draft. A discount by a non-approver waits for the owner. */
  async create(actor: Actor, input: QuoteInput): Promise<{ id: string; number: string }> {
    const data = parse(quoteSchema, input);
    authorize(actor, 'quotes', 'edit');
    assertValidity(data.quoteDate, data.validTill);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const pos = await clientState(c, data.clientId);
      const company = await companyRow(c);
      const totals = quoteTotals(data.lines, data.discountPct, pos, company.state_code);
      const id = randomUUID();
      const number = await allocateNumber(c, 'quote', data.quoteDate, company.fy_start_month);
      await c.query(
        `INSERT INTO quotation (id, company_id, number, client_id, place_of_supply, title, site, quote_date, valid_till,
                                discount_pct, discount_approved, terms, taxable, total, created_by, updated_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, app_user_id(), app_user_id())`,
        [
          id,
          number,
          data.clientId,
          pos,
          data.title,
          data.site ?? null,
          data.quoteDate,
          data.validTill,
          data.discountPct,
          discountApproved(actor, data.discountPct, totals.discount, null),
          data.terms ?? null,
          toDecimalString(totals.taxable),
          toDecimalString(totals.total),
        ],
      );
      await writeDocLines(c, 'quotation', id, data.lines);
      await writeAudit(c, {
        action: 'create',
        entity: 'quotation',
        entityId: id,
        after: { number, ...data, total: totals.total },
      });
      return { id, number };
    });
  }

  /** Edits a Draft (a sent quote is changed by revising it). */
  async update(actor: Actor, id: string, input: QuoteUpdate): Promise<void> {
    assertId(id, 'Quotation');
    const data = parse(updateSchema, input);
    authorize(actor, 'quotes', 'edit');
    assertValidity(data.quoteDate, data.validTill);
    await withTenant(this.pool, ctx(actor), async (c) => {
      const before = await this.load(c, actor, id, true);
      authorize(actor, 'quotes', 'edit', before.projectId ?? undefined);
      assertVersion(before, data.version);
      if (before.status !== 'draft')
        throw new DomainError('CONFLICT', 'Only a draft can be edited. Revise a sent quotation.');
      const pos =
        data.clientId === before.clientId
          ? before.placeOfSupply
          : await clientState(c, data.clientId);
      const company = await companyRow(c);
      const totals = quoteTotals(data.lines, data.discountPct, pos, company.state_code);
      await c.query(
        `UPDATE quotation SET client_id = $2, place_of_supply = $3, title = $4, site = $5, quote_date = $6,
                valid_till = $7, discount_pct = $8, discount_approved = $9, terms = $10, taxable = $11, total = $12,
                version = version + 1, updated_by = app_user_id()
          WHERE id = $1`,
        [
          id,
          data.clientId,
          pos,
          data.title,
          pick(data.site, before.site),
          data.quoteDate,
          data.validTill,
          data.discountPct,
          discountApproved(actor, data.discountPct, totals.discount, before),
          pick(data.terms, before.terms),
          toDecimalString(totals.taxable),
          toDecimalString(totals.total),
        ],
      );
      await writeDocLines(c, 'quotation', id, data.lines);
      const after = await this.load(c, actor, id);
      await writeAudit(c, { action: 'update', entity: 'quotation', entityId: id, before, after });
    });
  }

  /** Only Draft quotes can be deleted, with `quotes = full` (FR-5.8). */
  async remove(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Quotation');
    authorize(actor, 'quotes', 'full');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const before = await this.load(c, actor, id, true);
      authorize(actor, 'quotes', 'full', before.projectId ?? undefined);
      if (before.status !== 'draft')
        throw new DomainError('CONFLICT', 'Only a draft quotation can be deleted.');
      // BUG-082: a revised quote has been sent to the client; its history must stay.
      if (before.revision > 0) {
        throw new DomainError(
          'CONFLICT',
          'This quotation has been sent before (it has revisions) and cannot be deleted. Mark it declined instead.',
        );
      }
      await c.query('DELETE FROM quotation WHERE id = $1', [id]);
      await writeAudit(c, {
        action: 'delete',
        entity: 'quotation',
        entityId: id,
        before: { number: before.number, revision: before.revision, total: before.total },
      });
    });
  }

  /** ENGINEERING-STANDARDS H2: the owner (approvals = full) approves a discount before sending. */
  async approveDiscount(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Quotation');
    authorize(actor, 'approvals', 'full');
    await this.transition(actor, id, 'approve_discount', (q) => {
      if (q.status !== 'draft' || q.discountApproved)
        throw new DomainError('CONFLICT', 'This quotation has no discount waiting for approval.');
      return 'discount_approved = true';
    });
  }

  /** Draft → Sent. Blocked while a discount waits for approval. */
  async send(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Quotation');
    authorize(actor, 'quotes', 'edit');
    await this.transition(actor, id, 'send', (q) => {
      if (q.status !== 'draft') throw new DomainError('CONFLICT', 'Only a draft can be sent.');
      if (!q.discountApproved) {
        throw new DomainError(
          'CONFLICT',
          `The ${q.discountPct}% discount is waiting for the owner’s approval.`,
        );
      }
      return `status = 'sent'`;
    });
  }

  /** Sent (or expired) → Declined. */
  async decline(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Quotation');
    authorize(actor, 'quotes', 'edit');
    await this.transition(actor, id, 'decline', (q) => {
      if (q.status !== 'sent' && q.status !== 'expired')
        throw new DomainError('CONFLICT', 'Only a sent quotation can be declined.');
      return `status = 'declined'`;
    });
  }

  /**
   * FR-5.4: keeps the number, stores the current version (rev, date, total, status and lines) in
   * the history, increments the revision and resets to Draft. Accepted quotes are final.
   */
  async revise(actor: Actor, id: string): Promise<{ revision: number }> {
    assertId(id, 'Quotation');
    authorize(actor, 'quotes', 'edit');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const q = await this.load(c, actor, id, true);
      authorize(actor, 'quotes', 'edit', q.projectId ?? undefined);
      if (q.status === 'draft' || q.status === 'accepted') {
        throw new DomainError(
          'CONFLICT',
          q.status === 'draft'
            ? 'Edit the draft instead.'
            : 'An accepted quotation cannot be revised.',
        );
      }
      await c.query(
        `INSERT INTO quotation_revision (company_id, quotation_id, revision, status, quote_date, total, snapshot, created_by)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, app_user_id())`,
        [id, q.revision, q.status, q.quoteDate, toDecimalString(q.total), snapshotOf(q)],
      );
      await c.query(
        `UPDATE quotation SET revision = revision + 1, status = 'draft', version = version + 1,
                updated_by = app_user_id() WHERE id = $1`,
        [id],
      );
      await writeAudit(c, {
        action: 'revise',
        entity: 'quotation',
        entityId: id,
        before: { revision: q.revision, status: q.status, total: q.total },
        after: { revision: q.revision + 1, status: 'draft' },
      });
      return { revision: q.revision + 1 };
    });
  }

  /**
   * FR-5.5: accepting a Sent, unexpired quote creates the project (contract value = quoted
   * taxable value, cost budget default 75%) or, for a service quote, links an existing project
   * of the same client (FR-5.7).
   */
  async accept(
    actor: Actor,
    id: string,
    input: AcceptInput = {},
  ): Promise<{ projectId: string; projectCode: string }> {
    assertId(id, 'Quotation');
    const data = parse(acceptSchema, input);
    authorize(actor, 'quotes', 'edit');
    authorize(actor, 'projects', data.projectId ? 'view' : 'edit');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const q = await this.load(c, actor, id, true);
      authorize(actor, 'quotes', 'edit', q.projectId ?? undefined);
      if (q.status !== 'sent') {
        throw new DomainError(
          'CONFLICT',
          q.status === 'expired'
            ? 'This quotation has expired. Revise it and send it again.'
            : 'Only a sent quotation can be accepted.',
        );
      }
      const project = data.projectId
        ? await linkProject(c, actor, data.projectId, q.clientId)
        : await createProjectTx(c, actor, projectFromQuote(q, data));
      await c.query(
        `UPDATE quotation SET status = 'accepted', project_id = $2, version = version + 1, updated_by = app_user_id()
          WHERE id = $1`,
        [id, project.id],
      );
      await writeAudit(c, {
        action: 'accept',
        entity: 'quotation',
        entityId: id,
        after: { projectId: project.id, projectCode: project.code },
      });
      return { projectId: project.id, projectCode: project.code };
    });
  }

  /** FR-5.6: a tax invoice from an accepted quote, lines copied with the discount applied to rates. */
  async toInvoice(
    actor: Actor,
    id: string,
    input: z.input<typeof toInvoiceSchema>,
  ): Promise<{ id: string; number: string }> {
    assertId(id, 'Quotation');
    const data = parse(toInvoiceSchema, input);
    authorize(actor, 'invoices', 'edit');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const q = await this.load(c, actor, id, true);
      const projectId = acceptedProject(q);
      if (!can(actor, 'invoices', 'view', projectId))
        throw new DomainError('NOT_FOUND', 'Project not found.');
      authorize(actor, 'invoices', 'edit', projectId);
      const bp = toBasisPoints(q.discountPct);
      // Discount applied to the rates (FR-5.6); per-unit rounding may differ from the quote by
      // up to half a paisa per unit.
      const lines = q.lines.map((l) => ({ ...l, rate: mulDivHalfUp(l.rate, 10_000 - bp, 10_000) }));
      const taxable = lines.reduce((t, l) => t + mulDivHalfUp(l.rate, l.qtyMilli, 1000), 0);
      await assertWithinQuote(c, q, taxable);
      const inv = await issueInvoiceTx(c, {
        projectId,
        invoiceDate: data.invoiceDate,
        dueDate: data.dueDate,
        lines,
        quotationId: id,
      });
      return { id: inv.id, number: inv.number };
    });
  }

  /** Loads, checks the change and applies one status update in a transaction. */
  private async transition(
    actor: Actor,
    id: string,
    action: string,
    check: (q: QuoteDetail) => string,
  ): Promise<void> {
    await withTenant(this.pool, ctx(actor), async (c) => {
      const q = await this.load(c, actor, id, true);
      authorize(actor, 'quotes', 'edit', q.projectId ?? undefined);
      const set = check(q);
      await c.query(
        `UPDATE quotation SET ${set}, version = version + 1, updated_by = app_user_id() WHERE id = $1`,
        [id],
      );
      await writeAudit(c, {
        action,
        entity: 'quotation',
        entityId: id,
        before: { status: q.status, discountApproved: q.discountApproved },
      });
    });
  }

  private async load(
    c: pg.PoolClient,
    actor: Actor,
    id: string,
    forUpdate = false,
  ): Promise<QuoteDetail> {
    if (forUpdate) await c.query('SELECT 1 FROM quotation WHERE id = $1 FOR UPDATE', [id]);
    const head = await c.query<
      SummaryRow & {
        version: number;
        site: string | null;
        terms: string | null;
        place_of_supply: string;
      }
    >(
      `SELECT s.*, q.version, q.site, q.terms, q.place_of_supply
         FROM (${WITH_STATUS}) s JOIN quotation q ON q.id = s.id WHERE s.id = $2`,
      [todayIn(), id],
    );
    const r = head.rows[0];
    if (!r || !visible(actor, r.project_id))
      throw new DomainError('NOT_FOUND', 'Quotation not found.');
    const lines = await readDocLines(c, 'quotation', id);
    const company = await companyRow(c);
    return {
      ...toSummary(r),
      version: r.version,
      site: r.site,
      terms: r.terms,
      placeOfSupply: r.place_of_supply,
      lines,
      totals: quoteTotals(lines, Number(r.discount_pct), r.place_of_supply, company.state_code),
      ...(await linked(c, id)),
    };
  }
}

async function linked(
  c: pg.PoolClient,
  id: string,
): Promise<Pick<QuoteDetail, 'revisions' | 'proformas' | 'invoices'>> {
  const revisions = await c.query<{
    revision: number;
    status: string;
    quote_date: string;
    total: string;
    created_at: Date;
  }>(
    `SELECT revision, status, to_char(quote_date, 'YYYY-MM-DD') AS quote_date, total::text, created_at
       FROM quotation_revision WHERE quotation_id = $1 ORDER BY revision DESC`,
    [id],
  );
  const proformas = await c.query<{ id: string; number: string; status: string; total: string }>(
    'SELECT id, number, status, total::text FROM proforma WHERE quotation_id = $1 ORDER BY pf_date, number',
    [id],
  );
  const invoices = await c.query<{ id: string; number: string; total: string }>(
    'SELECT id, number, total::text FROM invoice WHERE quotation_id = $1 ORDER BY invoice_date, number',
    [id],
  );
  return {
    revisions: revisions.rows.map((v) => ({
      revision: v.revision,
      status: v.status,
      quoteDate: v.quote_date,
      total: fromDecimalString(v.total),
      createdAt: v.created_at.toISOString(),
    })),
    proformas: proformas.rows.map((p) => ({ ...p, total: fromDecimalString(p.total) })),
    invoices: invoices.rows.map((i) => ({ ...i, total: fromDecimalString(i.total) })),
  };
}

/** FR-5.5: name and site from the quote, contract = quoted taxable value, budget default 75%. */
function projectFromQuote(q: QuoteDetail, data: z.output<typeof acceptSchema>): Fields {
  return {
    name: data.name ?? q.title,
    clientId: q.clientId,
    siteAddress: data.siteAddress ?? q.site,
    status: 'active',
    startDate: data.startDate ?? todayIn(),
    endDate: data.endDate ?? null,
    contractValue: q.taxable,
    costBudget: data.costBudget ?? percentOf(q.taxable, DEFAULT_BUDGET_PCT),
    managerId: data.managerId ?? null,
    engineerId: data.engineerId ?? null,
  };
}

/** The project an accepted quote created or linked; documents are raised against it. */
export function acceptedProject(q: Pick<QuoteDetail, 'status' | 'projectId'>): string {
  if (q.status !== 'accepted' || !q.projectId)
    throw new DomainError('CONFLICT', 'Accept the quotation first.');
  return q.projectId;
}

/** Plain JSON of what the client saw at this revision (jsonb snapshot; never changed). */
function snapshotOf(q: QuoteDetail): string {
  return JSON.stringify({
    title: q.title,
    site: q.site,
    quoteDate: q.quoteDate,
    validTill: q.validTill,
    discountPct: q.discountPct,
    terms: q.terms,
    lines: q.lines,
    taxable: q.taxable,
    total: q.total,
  });
}

/**
 * A discount is approved when there is none, when an approver set it, or when neither the rate
 * nor the rupee amount changed from an already approved version (BUG-085: re-pricing the lines
 * at the same percentage changes the discount the owner approved).
 */
function discountApproved(
  actor: Actor,
  pct: number,
  amount: Paise,
  before: Pick<QuoteDetail, 'discountPct' | 'discountApproved' | 'totals'> | null,
): boolean {
  if (pct === 0 || !requiresApproval(actor)) return true;
  return (
    before !== null &&
    before.discountApproved &&
    before.discountPct === pct &&
    before.totals.discount === amount
  );
}

/**
 * BUG-086: everything raised from one quote (live proformas, and invoices not converted from one
 * of those proformas) stays within its taxable value. The tolerance covers per-unit rounding
 * when the discount is applied to rates (half a paisa per unit, FR-5.6). The quote row must
 * already be locked FOR UPDATE by the caller.
 */
export async function assertWithinQuote(
  c: pg.PoolClient,
  quote: { id: string; number: string; taxable: Paise; lines: readonly DocLine[] },
  newTaxable: Paise,
): Promise<void> {
  const { rows } = await c.query<{ billed: string }>(
    `SELECT ((SELECT coalesce(sum(taxable), 0) FROM proforma WHERE quotation_id = $1 AND status <> 'cancelled')
           + (SELECT coalesce(sum(taxable), 0) FROM invoice
               WHERE quotation_id = $1 AND proforma_id IS NULL AND status <> 'cancelled'))::text AS billed`,
    [quote.id],
  );
  const billed = fromDecimalString(rows[0]?.billed ?? '0');
  const tolerance = quote.lines.reduce((t, l) => t + Math.ceil(l.qtyMilli / 2000), 0);
  if (billed + newTaxable > quote.taxable + tolerance) {
    throw new DomainError(
      'CONFLICT',
      `This would bill more than ${quote.number} (already billed ${formatInr(billed)} of ${formatInr(quote.taxable)} before GST).`,
    );
  }
}

export function quoteTotals(
  lines: readonly DocLine[],
  discount: number,
  placeOfSupply: string,
  companyStateCode: string,
): DocumentTotals {
  const t = computeDocument(
    lines.map((l) => ({ ...l })),
    { discountPct: discount, placeOfSupply, companyStateCode },
  );
  if (t.total <= 0)
    throw new DomainError('VALIDATION', 'The quotation total must be more than zero.', 'lines');
  return t;
}

function assertValidity(quoteDate: IsoDate, validTill: IsoDate): void {
  if (validTill < quoteDate) {
    throw new DomainError('VALIDATION', 'Valid till cannot be before the quote date.', 'validTill');
  }
}

function assertVersion(q: QuoteDetail, version: number): void {
  if (q.version !== version) {
    throw new DomainError(
      'CONFLICT',
      'This quotation was changed by someone else. Reload it and try again.',
    );
  }
}

/** The client's state is the place of supply (FR-5.2). FOR SHARE: archiving waits for us. */
async function clientState(c: pg.PoolClient, clientId: string): Promise<string> {
  const { rows } = await c.query<{ state_code: string }>(
    `SELECT state_code FROM contact WHERE id = $1 AND type = 'client' AND deleted_at IS NULL FOR SHARE`,
    [clientId],
  );
  const r = rows[0];
  if (!r) throw new DomainError('VALIDATION', 'Choose an existing client.', 'clientId');
  return r.state_code;
}

async function linkProject(
  c: pg.PoolClient,
  actor: Actor,
  projectId: string,
  clientId: string,
): Promise<{ id: string; code: string }> {
  if (!can(actor, 'projects', 'view', projectId))
    throw new DomainError('NOT_FOUND', 'Project not found.');
  const { rows } = await c.query<{ code: string; client_id: string; status: string }>(
    'SELECT code, client_id, status FROM project WHERE id = $1 FOR SHARE',
    [projectId],
  );
  const p = rows[0];
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found.');
  if (p.client_id !== clientId)
    throw new DomainError('VALIDATION', 'That project belongs to another client.', 'projectId');
  if (p.status === 'cancelled' || p.status === 'completed')
    throw new DomainError('VALIDATION', 'That project is closed.', 'projectId');
  return { id: projectId, code: p.code };
}
