import {
  AGEING_BUCKETS,
  ageingBucket,
  authorize,
  daysOverdue,
  fromDecimalString,
  projectScope,
  todayIn,
  type Actor,
  type AgeingBucket,
  type IsoDate,
  type Paise,
} from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { tenantOf as ctx } from './validation.js';

export interface OutstandingRow {
  id: string;
  number: string;
  partyName: string;
  projectCode: string;
  docDate: IsoDate;
  dueDate: IsoDate;
  total: Paise;
  balance: Paise;
  daysOverdue: number;
  bucket: AgeingBucket;
}

export interface Outstanding {
  side: 'receivables' | 'payables';
  asOf: IsoDate;
  rows: OutstandingRow[];
  /** Balance per bucket, and overall. */
  buckets: Record<AgeingBucket, Paise>;
  total: Paise;
}

/**
 * Client receivables and vendor payables with ageing (Req §4.14). Only tax invoices and posted
 * bills: proformas, pending expenses and pending payments are not outstanding (FR-14.2).
 */
export class OutstandingService {
  constructor(private readonly pool: pg.Pool) {}

  async receivables(actor: Actor): Promise<Outstanding> {
    authorize(actor, 'outstanding', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Raw>(
        `SELECT i.id, i.number, i.client_name AS party, p.code AS project_code,
                to_char(i.invoice_date, 'YYYY-MM-DD') AS doc_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
                i.total::text, b.balance::text
           FROM invoice i JOIN invoice_balance b ON b.invoice_id = i.id JOIN project p ON p.id = i.project_id
          WHERE i.status <> 'cancelled' AND b.balance > 0
            AND ($1::uuid[] IS NULL OR i.project_id = ANY($1::uuid[]))
          ORDER BY i.due_date, i.number`,
        [projectScope(actor)],
      );
      return summarise('receivables', rows);
    });
  }

  /** Bills less approved payments (a pending payment has not been paid yet). */
  async payables(actor: Actor): Promise<Outstanding> {
    authorize(actor, 'outstanding', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Raw>(
        `SELECT b.id, b.bill_no AS number, b.vendor_name AS party, p.code AS project_code,
                to_char(b.bill_date, 'YYYY-MM-DD') AS doc_date, to_char(b.due_date, 'YYYY-MM-DD') AS due_date,
                b.total::text, x.balance::text
           FROM bill b JOIN bill_balance x ON x.bill_id = b.id JOIN project p ON p.id = b.project_id
          WHERE b.deleted_at IS NULL AND x.balance > 0
            AND ($1::uuid[] IS NULL OR b.project_id = ANY($1::uuid[]))
          ORDER BY b.due_date, b.bill_no`,
        [projectScope(actor)],
      );
      return summarise('payables', rows);
    });
  }

  /** H4: an export of either side writes an audit row. */
  async export(actor: Actor, side: Outstanding['side']): Promise<Outstanding> {
    const data =
      side === 'receivables' ? await this.receivables(actor) : await this.payables(actor);
    await withTenant(this.pool, ctx(actor), (c) =>
      writeAudit(c, {
        action: 'export',
        entity: 'outstanding',
        entityId: null,
        after: { format: 'csv', side, rows: data.rows.length },
      }),
    );
    return data;
  }
}

interface Raw {
  id: string;
  number: string;
  party: string;
  project_code: string;
  doc_date: string;
  due_date: string;
  total: string;
  balance: string;
}

function summarise(side: Outstanding['side'], raw: Raw[]): Outstanding {
  const asOf = todayIn();
  const buckets = Object.fromEntries(AGEING_BUCKETS.map((b) => [b, 0])) as Record<
    AgeingBucket,
    Paise
  >;
  const rows = raw.map((r): OutstandingRow => {
    const overdue = daysOverdue(r.due_date, asOf);
    const bucket = ageingBucket(overdue);
    const balance = fromDecimalString(r.balance);
    buckets[bucket] += balance;
    return {
      id: r.id,
      number: r.number,
      partyName: r.party,
      projectCode: r.project_code,
      docDate: r.doc_date,
      dueDate: r.due_date,
      total: fromDecimalString(r.total),
      balance,
      daysOverdue: overdue,
      bucket,
    };
  });
  return { side, asOf, rows, buckets, total: rows.reduce((s, r) => s + r.balance, 0) };
}
