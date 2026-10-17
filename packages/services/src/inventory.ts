import {
  DomainError,
  MATERIAL_CATEGORIES,
  assertId,
  assertNotLocked,
  authorize,
  can,
  fromDecimalString,
  mulDivHalfUp,
  projectScope,
  toDecimalString,
  todayIn,
  type Actor,
  type IsoDate,
  type MaterialCategory,
  type Paise,
} from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { companyRow, isoDate, parse, tenantOf as ctx } from './validation.js';

const purchaseSchema = z.object({
  projectId: z.string().uuid('Choose a project.'),
  purchaseDate: isoDate.refine((v) => v <= todayIn(), 'A purchase cannot be dated in the future.'),
  item: z.string().trim().min(1, 'Enter the item.').max(160),
  category: z.enum(MATERIAL_CATEGORIES, { message: 'Choose a category.' }),
  unit: z.string().trim().min(1, 'Enter the unit (Sheet, Nos, Sqft…).').max(20),
  /** Thousandths, like document quantities. */
  qtyMilli: z.number().int('Quantity has at most 3 decimals.').positive('Enter the quantity.'),
  amount: z.number().int('Amount must be in paise.').positive('Amount must be more than zero.'),
  vendorName: z.string().trim().min(1, 'Enter the vendor.').max(160),
  billId: z.string().uuid().nullable().optional(),
});
export type MaterialPurchaseInput = z.input<typeof purchaseSchema>;

export interface MaterialPurchase {
  id: string;
  projectId: string;
  projectCode: string;
  purchaseDate: IsoDate;
  item: string;
  category: MaterialCategory;
  unit: string;
  qtyMilli: number;
  amount: Paise;
  /** Amount per unit, to the paisa. */
  averageRate: Paise;
  vendorName: string;
  billId: string | null;
  createdBy: string | null;
}

export interface InventoryView {
  purchases: MaterialPurchase[];
  /** Category summary cards, largest first. */
  byCategory: { category: MaterialCategory; amount: Paise; count: number }[];
  total: Paise;
}

export const INVENTORY_MAX = 50_000;

interface Row {
  id: string;
  project_id: string;
  project_code: string;
  purchase_date: string;
  item: string;
  category: MaterialCategory;
  unit: string;
  qty_milli: string;
  amount: string;
  vendor_name: string;
  bill_id: string | null;
  created_by: string | null;
}

const SELECT = `
  SELECT m.id, m.project_id, p.code AS project_code, to_char(m.purchase_date, 'YYYY-MM-DD') AS purchase_date,
         m.item, m.category, m.unit, m.qty_milli::text, m.amount::text, m.vendor_name, m.bill_id, m.created_by
    FROM material_purchase m JOIN project p ON p.id = m.project_id
   WHERE m.deleted_at IS NULL AND ($1::uuid[] IS NULL OR m.project_id = ANY($1::uuid[]))
     AND ($2::uuid IS NULL OR m.project_id = $2)`;

const toPurchase = (r: Row): MaterialPurchase => {
  const amount = fromDecimalString(r.amount);
  const qtyMilli = Number(r.qty_milli);
  return {
    id: r.id,
    projectId: r.project_id,
    projectCode: r.project_code,
    purchaseDate: r.purchase_date,
    item: r.item,
    category: r.category,
    unit: r.unit,
    qtyMilli,
    amount,
    averageRate: mulDivHalfUp(amount, 1000, qtyMilli),
    vendorName: r.vendor_name,
    billId: r.bill_id,
    createdBy: r.created_by,
  };
};

function summarise(purchases: MaterialPurchase[]): InventoryView {
  const map = new Map<MaterialCategory, { amount: Paise; count: number }>();
  for (const x of purchases) {
    const s = map.get(x.category) ?? { amount: 0, count: 0 };
    map.set(x.category, { amount: s.amount + x.amount, count: s.count + 1 });
  }
  const byCategory = [...map.entries()]
    .map(([category, s]) => ({ category, ...s }))
    .sort((a, b) => b.amount - a.amount);
  return { purchases, byCategory, total: purchases.reduce((n, x) => n + x.amount, 0) };
}

/**
 * Inventory (FR-18): material purchase tracking per project. No stock levels or transfers, and it
 * posts nothing: the cost reaches the books through the bill or expense that paid for it.
 */
export class InventoryService {
  constructor(private readonly pool: pg.Pool) {}

  async list(
    actor: Actor,
    filter: { projectId?: string | undefined } = {},
  ): Promise<InventoryView> {
    authorize(actor, 'inventory', 'view', filter.projectId);
    if (filter.projectId) assertId(filter.projectId, 'Project');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Row>(
        `${SELECT} ORDER BY m.purchase_date DESC, m.created_at DESC LIMIT 2000`,
        [projectScope(actor), filter.projectId ?? null],
      );
      return summarise(rows.map(toPurchase));
    });
  }

  /** Every match for a CSV download; H4: the export writes an audit row. */
  async export(
    actor: Actor,
    filter: { projectId?: string | undefined } = {},
  ): Promise<MaterialPurchase[]> {
    authorize(actor, 'inventory', 'view', filter.projectId);
    if (filter.projectId) assertId(filter.projectId, 'Project');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Row>(
        `${SELECT} ORDER BY m.purchase_date DESC, m.created_at DESC LIMIT ${INVENTORY_MAX + 1}`,
        [projectScope(actor), filter.projectId ?? null],
      );
      if (rows.length > INVENTORY_MAX)
        throw new DomainError('VALIDATION', 'Too many rows. Filter by project first.');
      await writeAudit(c, {
        action: 'export',
        entity: 'material_purchase',
        entityId: null,
        after: { format: 'csv', filter, rows: rows.length },
      });
      return rows.map(toPurchase);
    });
  }

  /** "+ Record purchase". A linked bill must be on the same project. */
  async record(actor: Actor, input: MaterialPurchaseInput): Promise<{ id: string }> {
    const data = parse(purchaseSchema, input);
    authorize(actor, 'inventory', 'edit', data.projectId);
    return withTenant(this.pool, ctx(actor), async (c) => {
      assertNotLocked(data.purchaseDate, (await companyRow(c)).lock_date, 'purchaseDate');
      if (data.billId) {
        const { rows } = await c.query<{ project_id: string }>(
          `SELECT project_id FROM bill WHERE id = $1 AND deleted_at IS NULL`,
          [data.billId],
        );
        if (rows[0]?.project_id !== data.projectId)
          throw new DomainError('VALIDATION', 'Pick a bill on the same project.', 'billId');
      }
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO material_purchase (company_id, project_id, purchase_date, item, category, unit, qty_milli,
                                        amount, vendor_name, bill_id, created_by)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, app_user_id()) RETURNING id`,
        [
          data.projectId,
          data.purchaseDate,
          data.item,
          data.category,
          data.unit,
          data.qtyMilli,
          toDecimalString(data.amount),
          data.vendorName,
          data.billId ?? null,
        ],
      );
      const id = rows[0]!.id;
      await writeAudit(c, {
        action: 'create',
        entity: 'material_purchase',
        entityId: id,
        after: data,
      });
      return { id };
    });
  }

  /** Its author, or `inventory = full`, removes an entry in an open period. */
  async remove(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Purchase');
    authorize(actor, 'inventory', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Row>(`${SELECT} AND m.id = $3 FOR UPDATE OF m`, [
        projectScope(actor),
        null,
        id,
      ]);
      const r = rows[0];
      if (!r || !can(actor, 'inventory', 'view', r.project_id))
        throw new DomainError('NOT_FOUND', 'Purchase not found.');
      if (r.created_by !== actor.userId) authorize(actor, 'inventory', 'full', r.project_id);
      await c.query(
        `UPDATE material_purchase SET deleted_at = now(), deleted_by = app_user_id() WHERE id = $1`,
        [id],
      );
      await writeAudit(c, {
        action: 'delete',
        entity: 'material_purchase',
        entityId: id,
        before: { item: r.item, amount: r.amount },
      });
    });
  }
}
