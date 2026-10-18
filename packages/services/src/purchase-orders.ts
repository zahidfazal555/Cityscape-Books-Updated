import { randomUUID } from 'node:crypto';
import {
  DomainError,
  assertId,
  authorize,
  can,
  computeDocument,
  fromDecimalString,
  projectScope,
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
import { lineSchema } from './invoices.js';
import { companyRow, isoDate, parse, tenantOf as ctx } from './validation.js';

export const PO_STATUSES = ['draft', 'issued', 'partly_billed', 'billed', 'cancelled'] as const;
/** Stored: draft, issued, cancelled. Partly billed / Billed are derived from linked bills. */
export type PoStatus = (typeof PO_STATUSES)[number];

const gstRate = z.union([
  z.literal(0),
  z.literal(5),
  z.literal(12),
  z.literal(18),
  z.literal(28),
  z.literal(40),
]);
const poLine = lineSchema.omit({ gstRate: true });
const poSchema = z.object({
  vendorId: z.string().uuid('Choose a vendor.'),
  projectId: z.string().uuid('Choose the deliver-to project.'),
  gstRate: gstRate.default(18),
  poDate: isoDate,
  deliverBy: isoDate.nullable().optional(),
  lines: z.array(poLine).min(1, 'Add at least one line.').max(200),
  terms: z.string().trim().max(4000).nullable().optional(),
});
const updateSchema = poSchema
  .omit({ vendorId: true, projectId: true })
  .extend({ version: z.number().int().positive() });

export type PoInput = z.input<typeof poSchema>;
export type PoUpdate = z.input<typeof updateSchema>;

export interface PoSummary {
  id: string;
  number: string;
  poDate: IsoDate;
  deliverBy: IsoDate | null;
  vendorId: string;
  vendorName: string;
  vendorGstin: string | null;
  projectId: string;
  projectCode: string;
  gstRate: number;
  taxable: Paise;
  total: Paise;
  billed: Paise;
  /** Taxable value not yet billed (never below zero). */
  unbilled: Paise;
  status: PoStatus;
  /** Deliver-by has passed and the PO is not fully billed (FR-9.1). */
  overdue: boolean;
}

export interface PoDetail extends PoSummary {
  version: number;
  /** The vendor's registration now: an edit re-applies it (BUG-117). */
  currentVendor: { gstin: string | null; stateCode: string };
  terms: string | null;
  lines: DocLine[];
  totals: DocumentTotals;
  bills: { id: string; billNo: string; billDate: IsoDate; taxable: Paise; total: Paise }[];
}

/** $1 = today. */
const WITH_STATUS = `
  SELECT o.id, o.number, to_char(o.po_date, 'YYYY-MM-DD') AS po_date,
         to_char(o.deliver_by, 'YYYY-MM-DD') AS deliver_by, o.vendor_id, k.name AS vendor_name, o.vendor_gstin,
         o.project_id, p.code AS project_code, o.gst_rate::text, o.taxable::text, o.total::text, b.billed::text,
         CASE WHEN o.status IN ('draft', 'cancelled') THEN o.status
              WHEN b.billed >= o.taxable THEN 'billed'
              WHEN b.billed > 0 THEN 'partly_billed'
              ELSE 'issued' END AS status,
         (o.status = 'issued' AND b.billed < o.taxable AND o.deliver_by < $1::date) AS overdue
    FROM purchase_order o
    JOIN contact k ON k.id = o.vendor_id
    JOIN project p ON p.id = o.project_id
    JOIN purchase_order_billed b ON b.purchase_order_id = o.id`;

interface SummaryRow {
  id: string;
  number: string;
  po_date: string;
  deliver_by: string | null;
  vendor_id: string;
  vendor_name: string;
  vendor_gstin: string | null;
  project_id: string;
  project_code: string;
  gst_rate: string;
  taxable: string;
  total: string;
  billed: string;
  status: PoStatus;
  overdue: boolean;
}

function toSummary(r: SummaryRow): PoSummary {
  const taxable = fromDecimalString(r.taxable);
  const billed = fromDecimalString(r.billed);
  return {
    id: r.id,
    number: r.number,
    poDate: r.po_date,
    deliverBy: r.deliver_by,
    vendorId: r.vendor_id,
    vendorName: r.vendor_name,
    vendorGstin: r.vendor_gstin,
    projectId: r.project_id,
    projectCode: r.project_code,
    gstRate: Number(r.gst_rate),
    taxable,
    total: fromDecimalString(r.total),
    billed,
    unbilled: Math.max(0, taxable - billed),
    status: r.status,
    overdue: r.overdue,
  };
}

/** Purchase orders PO/FY/#### (Req §4.9). A PO is a commitment only: it posts nothing. */
export class PurchaseOrdersService {
  constructor(private readonly pool: pg.Pool) {}

  async list(
    actor: Actor,
    filter: { status?: PoStatus | undefined; projectId?: string | undefined } = {},
  ): Promise<PoSummary[]> {
    authorize(actor, 'pos', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<SummaryRow>(
        `SELECT * FROM (${WITH_STATUS}) s
          WHERE ($2::uuid[] IS NULL OR s.project_id = ANY($2::uuid[]))
            AND ($3::text IS NULL OR s.status = $3) AND ($4::uuid IS NULL OR s.project_id = $4)
          ORDER BY s.po_date DESC, s.number DESC LIMIT 500`,
        [todayIn(), projectScope(actor), filter.status ?? null, filter.projectId ?? null],
      );
      return rows.map(toSummary);
    });
  }

  async get(actor: Actor, id: string): Promise<PoDetail> {
    assertId(id, 'Purchase order');
    authorize(actor, 'pos', 'view');
    return withTenant(this.pool, ctx(actor), (c) => this.load(c, actor, id));
  }

  /** Draft PO/FY/####. An unregistered vendor gets no GST (FR-9.2). */
  async create(actor: Actor, input: PoInput): Promise<{ id: string; number: string }> {
    const data = parse(poSchema, input);
    authorize(actor, 'pos', 'edit');
    if (!can(actor, 'pos', 'view', data.projectId))
      throw new DomainError('NOT_FOUND', 'Project not found.');
    authorize(actor, 'pos', 'edit', data.projectId);
    assertDates(data.poDate, data.deliverBy ?? null);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const vendor = await vendorParty(c, data.vendorId);
      await assertLiveProject(c, data.projectId);
      const company = await companyRow(c);
      const rate = vendor.gstin ? data.gstRate : 0;
      const lines = data.lines.map((l) => ({ ...l, gstRate: rate }));
      const totals = poTotals(lines, vendor.state_code, company.state_code);
      const id = randomUUID();
      const number = await allocateNumber(c, 'purchaseOrder', data.poDate, company.fy_start_month);
      await c.query(
        `INSERT INTO purchase_order (id, company_id, number, vendor_id, vendor_gstin, project_id, gst_rate, po_date,
                                     deliver_by, terms, taxable, total, created_by, updated_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, app_user_id(), app_user_id())`,
        [
          id,
          number,
          data.vendorId,
          vendor.gstin,
          data.projectId,
          rate,
          data.poDate,
          data.deliverBy ?? null,
          data.terms ?? null,
          toDecimalString(totals.taxable),
          toDecimalString(totals.total),
        ],
      );
      await writeDocLines(c, 'purchaseOrder', id, lines);
      await writeAudit(c, {
        action: 'create',
        entity: 'purchase_order',
        entityId: id,
        after: { number, ...data, gstRate: rate, total: totals.total },
      });
      return { id, number };
    });
  }

  /** Edits a Draft. */
  async update(actor: Actor, id: string, input: PoUpdate): Promise<void> {
    assertId(id, 'Purchase order');
    const data = parse(updateSchema, input);
    authorize(actor, 'pos', 'edit');
    assertDates(data.poDate, data.deliverBy ?? null);
    await withTenant(this.pool, ctx(actor), async (c) => {
      const before = await this.load(c, actor, id, true);
      authorize(actor, 'pos', 'edit', before.projectId);
      if (before.version !== data.version) {
        throw new DomainError(
          'CONFLICT',
          'This purchase order was changed by someone else. Reload it and try again.',
        );
      }
      if (before.status !== 'draft')
        throw new DomainError('CONFLICT', 'Only a draft purchase order can be edited.');
      const vendor = await vendorParty(c, before.vendorId);
      const company = await companyRow(c);
      const rate = vendor.gstin ? data.gstRate : 0;
      const lines = data.lines.map((l) => ({ ...l, gstRate: rate }));
      const totals = poTotals(lines, vendor.state_code, company.state_code);
      await c.query(
        `UPDATE purchase_order SET gst_rate = $2, po_date = $3, deliver_by = $4, terms = $5, taxable = $6,
                total = $7, vendor_gstin = $8, version = version + 1, updated_by = app_user_id()
          WHERE id = $1`,
        [
          id,
          rate,
          data.poDate,
          data.deliverBy ?? null,
          data.terms ?? null,
          toDecimalString(totals.taxable),
          toDecimalString(totals.total),
          vendor.gstin,
        ],
      );
      await writeDocLines(c, 'purchaseOrder', id, lines);
      const after = await this.load(c, actor, id);
      await writeAudit(c, {
        action: 'update',
        entity: 'purchase_order',
        entityId: id,
        before,
        after,
      });
    });
  }

  /** Draft → Issued. */
  async issue(actor: Actor, id: string): Promise<void> {
    await this.transition(actor, id, 'issue', 'edit', (po) => {
      if (po.status !== 'draft') throw new DomainError('CONFLICT', 'Only a draft can be issued.');
      return 'issued';
    });
  }

  /** FR-9.3: cancel only when no bill is linked. */
  async cancel(actor: Actor, id: string): Promise<void> {
    await this.transition(actor, id, 'cancel', 'full', (po) => {
      if (po.status === 'cancelled')
        throw new DomainError('CONFLICT', 'This purchase order is already cancelled.');
      if (po.bills.length > 0) {
        throw new DomainError(
          'CONFLICT',
          'Bills are linked to this purchase order, so it cannot be cancelled.',
        );
      }
      return 'cancelled';
    });
  }

  /** FR-9.3: only drafts can be deleted (`pos = full`). */
  async remove(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Purchase order');
    authorize(actor, 'pos', 'full');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const po = await this.load(c, actor, id, true);
      authorize(actor, 'pos', 'full', po.projectId);
      if (po.status !== 'draft')
        throw new DomainError('CONFLICT', 'Only a draft purchase order can be deleted.');
      await c.query('DELETE FROM purchase_order WHERE id = $1', [id]);
      await writeAudit(c, {
        action: 'delete',
        entity: 'purchase_order',
        entityId: id,
        before: { number: po.number, total: po.total },
      });
    });
  }

  private async transition(
    actor: Actor,
    id: string,
    action: string,
    level: 'edit' | 'full',
    check: (po: PoDetail) => 'issued' | 'cancelled',
  ): Promise<void> {
    assertId(id, 'Purchase order');
    authorize(actor, 'pos', level);
    await withTenant(this.pool, ctx(actor), async (c) => {
      const po = await this.load(c, actor, id, true);
      authorize(actor, 'pos', level, po.projectId);
      const status = check(po);
      await c.query(
        `UPDATE purchase_order SET status = $2, version = version + 1, updated_by = app_user_id() WHERE id = $1`,
        [id, status],
      );
      await writeAudit(c, {
        action,
        entity: 'purchase_order',
        entityId: id,
        before: { status: po.status },
        after: { status },
      });
    });
  }

  private async load(
    c: pg.PoolClient,
    actor: Actor,
    id: string,
    forUpdate = false,
  ): Promise<PoDetail> {
    if (forUpdate) await c.query('SELECT 1 FROM purchase_order WHERE id = $1 FOR UPDATE', [id]);
    const head = await c.query<SummaryRow & { version: number; terms: string | null }>(
      `SELECT s.*, o.version, o.terms FROM (${WITH_STATUS}) s JOIN purchase_order o ON o.id = s.id
        WHERE s.id = $2`,
      [todayIn(), id],
    );
    const r = head.rows[0];
    if (!r || !can(actor, 'pos', 'view', r.project_id))
      throw new DomainError('NOT_FOUND', 'Purchase order not found.');
    const lines = await readDocLines(c, 'purchaseOrder', id);
    const company = await companyRow(c);
    const vendorState = await c.query<{ state_code: string; gstin: string | null }>(
      'SELECT state_code, gstin FROM contact WHERE id = $1',
      [r.vendor_id],
    );
    const bills = await c.query<{
      id: string;
      bill_no: string;
      bill_date: string;
      taxable: string;
      total: string;
    }>(
      `SELECT id, bill_no, to_char(bill_date, 'YYYY-MM-DD') AS bill_date, taxable::text, total::text
         FROM bill WHERE purchase_order_id = $1 AND deleted_at IS NULL ORDER BY bill_date, bill_no`,
      [id],
    );
    return {
      ...toSummary(r),
      version: r.version,
      currentVendor: currentOf(vendorState.rows[0], company.state_code),
      terms: r.terms,
      lines,
      totals: poTotals(
        lines,
        vendorState.rows[0]?.state_code ?? company.state_code,
        company.state_code,
      ),
      bills: bills.rows.map((b) => ({
        id: b.id,
        billNo: b.bill_no,
        billDate: b.bill_date,
        taxable: fromDecimalString(b.taxable),
        total: fromDecimalString(b.total),
      })),
    };
  }
}

function currentOf(
  v: { gstin: string | null; state_code: string } | undefined,
  companyState: string,
): { gstin: string | null; stateCode: string } {
  return { gstin: v?.gstin ?? null, stateCode: v?.state_code ?? companyState };
}

function poTotals(lines: readonly DocLine[], vendorState: string, companyState: string) {
  const t = computeDocument(
    lines.map((l) => ({ ...l })),
    { placeOfSupply: vendorState, companyStateCode: companyState },
  );
  if (t.taxable <= 0)
    throw new DomainError('VALIDATION', 'The purchase order must be worth something.', 'lines');
  return t;
}

function assertDates(poDate: IsoDate, deliverBy: IsoDate | null): void {
  if (deliverBy !== null && deliverBy < poDate) {
    throw new DomainError('VALIDATION', 'Deliver by cannot be before the PO date.', 'deliverBy');
  }
}

/** A live vendor or contractor; FOR SHARE so it cannot be archived under us. */
export async function vendorParty(
  c: pg.PoolClient,
  vendorId: string,
): Promise<{ name: string; gstin: string | null; state_code: string }> {
  const { rows } = await c.query<{ name: string; gstin: string | null; state_code: string }>(
    `SELECT name, gstin, state_code FROM contact
      WHERE id = $1 AND type IN ('vendor', 'contractor') AND deleted_at IS NULL FOR SHARE`,
    [vendorId],
  );
  const v = rows[0];
  if (!v) throw new DomainError('VALIDATION', 'Choose an existing vendor.', 'vendorId');
  return v;
}

/** New purchases need an open project; a bill may still arrive after completion. */
export async function assertLiveProject(
  c: pg.PoolClient,
  projectId: string,
  allowCompleted = false,
): Promise<void> {
  const { rows } = await c.query<{ status: string }>(
    'SELECT status FROM project WHERE id = $1 FOR SHARE',
    [projectId],
  );
  const p = rows[0];
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found.');
  if (p.status === 'cancelled' || (p.status === 'completed' && !allowCompleted))
    throw new DomainError('VALIDATION', 'This project is closed.', 'projectId');
}
