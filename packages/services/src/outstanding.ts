import {
  AGEING_BUCKETS,
  DomainError,
  ageingBucket,
  assertId,
  authorize,
  daysOverdue,
  financialYearStart,
  fromDecimalString,
  parseIsoDate,
  projectScope,
  todayIn,
  type Actor,
  type AgeingBucket,
  type IsoDate,
  type Paise,
} from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { tenantOf as ctx, type ExportFormat } from './validation.js';

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

export interface StatementLine {
  date: IsoDate;
  particulars: string;
  /** Raises what the client owes (an invoice). */
  debit: Paise;
  /** Lowers it (a receipt, an advance, a credit note). */
  credit: Paise;
  balance: Paise;
}

/** A client's account: invoices, receipts, advances and credit notes with a running balance. */
export interface ClientStatement {
  client: { id: string; name: string; gstin: string | null; address: string | null };
  from: IsoDate;
  to: IsoDate;
  /** Owed at the start of `from`; negative means an advance is held for the client. */
  opening: Paise;
  lines: StatementLine[];
  debit: Paise;
  credit: Paise;
  closing: Paise;
}

/**
 * Journals on receivables (1100) and customer advances (2100) tagged with the client. An edit or a
 * deleted receipt posts a reversal of the same source: the pair nets to zero and is left out, so
 * the statement shows what the client sees. A credit note is its own source and is shown.
 */
const STATEMENT_SQL = `
  SELECT to_char(j.txn_date, 'YYYY-MM-DD') AS date, j.narration,
         (sum(l.debit) - sum(l.credit))::text AS net
    FROM journal j
    JOIN journal_line l ON l.journal_id = j.id
    JOIN account a ON a.id = l.account_id
   WHERE l.contact_id = $1 AND a.code IN ('1100', '2100')
     AND ($3::uuid[] IS NULL OR l.project_id = ANY($3::uuid[]))
     AND j.txn_date <= $2
     AND NOT EXISTS (SELECT 1 FROM journal o WHERE o.id = j.reverses_journal_id AND o.source_type = j.source_type)
     AND NOT EXISTS (SELECT 1 FROM journal r WHERE r.reverses_journal_id = j.id AND r.source_type = j.source_type)
   GROUP BY j.id
  HAVING sum(l.debit) <> sum(l.credit)
   ORDER BY j.txn_date, j.posted_at, j.id`;

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
  async export(
    actor: Actor,
    side: Outstanding['side'],
    format: ExportFormat = 'csv',
  ): Promise<Outstanding> {
    const data =
      side === 'receivables' ? await this.receivables(actor) : await this.payables(actor);
    await withTenant(this.pool, ctx(actor), (c) =>
      writeAudit(c, {
        action: 'export',
        entity: 'outstanding',
        entityId: null,
        after: { format, side, rows: data.rows.length },
      }),
    );
    return data;
  }

  /** A client's statement of account for a date range (default: this financial year to date). */
  async statement(
    actor: Actor,
    clientId: string,
    range: { from?: string | undefined; to?: string | undefined } = {},
  ): Promise<ClientStatement> {
    authorize(actor, 'outstanding', 'view');
    assertId(clientId, 'Client');
    const to = range.to ?? todayIn();
    parseIsoDate(to, 'to');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const company = await c.query<{ fy_start_month: number }>(
        'SELECT fy_start_month FROM company',
      );
      const from = range.from ?? financialYearStart(to, company.rows[0]?.fy_start_month ?? 4);
      parseIsoDate(from, 'from');
      if (from > to)
        throw new DomainError('VALIDATION', 'The start date is after the end date.', 'from');
      const k = await c.query<{
        id: string;
        name: string;
        gstin: string | null;
        address: string | null;
      }>(
        `SELECT id, name, gstin, address FROM contact k
          WHERE k.id = $1 AND k.type = 'client'
            AND ($2::uuid[] IS NULL
                 OR EXISTS (SELECT 1 FROM project p WHERE p.client_id = k.id AND p.id = ANY($2::uuid[])))`,
        [clientId, projectScope(actor)],
      );
      // Outside the caller's projects the client does not exist for them (404, like receipts).
      const client = k.rows[0];
      if (!client) throw new DomainError('NOT_FOUND', 'Client not found.');
      const { rows } = await c.query<{ date: string; narration: string; net: string }>(
        STATEMENT_SQL,
        [clientId, to, projectScope(actor)],
      );
      const { opening, lines } = runningBalance(rows, from);
      const debit = lines.reduce((n, l) => n + l.debit, 0);
      const credit = lines.reduce((n, l) => n + l.credit, 0);
      return { client, from, to, opening, lines, debit, credit, closing: opening + debit - credit };
    });
  }
}

/** Entries before `from` make the opening balance; the rest carry a running balance from it. */
function runningBalance(
  rows: { date: string; narration: string; net: string }[],
  from: IsoDate,
): { opening: Paise; lines: StatementLine[] } {
  const before = rows.filter((r) => r.date < from);
  const opening = before.reduce((n, r) => n + fromDecimalString(r.net), 0);
  let balance = opening;
  const lines = rows
    .filter((r) => r.date >= from)
    .map((r): StatementLine => {
      const net = fromDecimalString(r.net);
      balance += net;
      return {
        date: r.date,
        particulars: r.narration,
        debit: Math.max(net, 0),
        credit: Math.max(-net, 0),
        balance,
      };
    });
  return { opening, lines };
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
