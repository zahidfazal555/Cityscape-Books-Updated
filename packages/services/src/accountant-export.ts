import {
  DomainError,
  authorize,
  can,
  financialYearStart,
  parseIsoDate,
  projectScope,
  todayIn,
  type Actor,
  type IsoDate,
  type Module,
} from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { tenantOf as ctx } from './validation.js';

export type CsvRow = (string | number)[];

export interface AccountantFile {
  name: string;
  rows: CsvRow[];
}

export interface AccountantPack {
  company: string;
  from: IsoDate;
  to: IsoDate;
  files: AccountantFile[];
}

/** One file: header row, then the query's rows in column order. Amounts stay as NUMERIC text. */
interface Sheet {
  name: string;
  header: string[];
  sql: string;
  /** Query parameters; by default $1 = from and $2 = to. */
  values?: (from: IsoDate, to: IsoDate) => IsoDate[];
  /** The module right the file needs, besides reports + pnl (H4: salaries need payroll). */
  module?: Module;
}

/** Deleted records are left out; pending and rejected ones are included with their status. */
const SHEETS: Sheet[] = [
  {
    name: 'day-book',
    header: [
      'Date',
      'Entry',
      'Source',
      'Narration',
      'Account code',
      'Account',
      'Project',
      'Party',
      'Debit',
      'Credit',
      'Reversal of entry',
    ],
    sql: `SELECT to_char(j.txn_date, 'YYYY-MM-DD'), j.id::text, j.source_type, j.narration,
                 a.code, a.name, coalesce(p.code, ''), coalesce(k.name, ''),
                 l.debit::text, l.credit::text, coalesce(j.reverses_journal_id::text, '')
            FROM journal j
            JOIN journal_line l ON l.journal_id = j.id
            JOIN account a ON a.id = l.account_id
            LEFT JOIN project p ON p.id = l.project_id
            LEFT JOIN contact k ON k.id = l.contact_id
           WHERE j.txn_date BETWEEN $1 AND $2
           ORDER BY j.txn_date, j.posted_at, j.id, l.debit DESC, a.code`,
  },
  {
    name: 'trial-balance',
    header: ['Account code', 'Account', 'Type', 'Debit', 'Credit'],
    sql: `SELECT a.code, a.name, a.type,
                 greatest(sum(l.debit - l.credit), 0)::text, greatest(sum(l.credit - l.debit), 0)::text
            FROM account a
            JOIN journal_line l ON l.account_id = a.id
            JOIN journal j ON j.id = l.journal_id
           WHERE j.txn_date <= $1
           GROUP BY a.code, a.name, a.type
          HAVING sum(l.debit) <> sum(l.credit)
           ORDER BY a.code`,
    // Closing balances on the last day of the period.
    values: (_from, to) => [to],
  },
  {
    name: 'sales-invoices',
    module: 'invoices',
    header: [
      'Number',
      'Date',
      'Due',
      'Client',
      'Client GSTIN',
      'Place of supply',
      'Project',
      'Taxable',
      'CGST',
      'SGST',
      'IGST',
      'Round off',
      'Total',
      'Status',
    ],
    sql: `SELECT i.number, to_char(i.invoice_date, 'YYYY-MM-DD'), to_char(i.due_date, 'YYYY-MM-DD'),
                 i.client_name, coalesce(i.client_gstin, ''), i.place_of_supply, p.code,
                 i.taxable::text, i.cgst::text, i.sgst::text, i.igst::text, i.round_off::text,
                 i.total::text, i.status
            FROM invoice i JOIN project p ON p.id = i.project_id
           WHERE i.invoice_date BETWEEN $1 AND $2
           ORDER BY i.invoice_date, i.number`,
  },
  {
    name: 'credit-notes',
    module: 'invoices',
    header: [
      'Number',
      'Date',
      'Against invoice',
      'Client',
      'Client GSTIN',
      'Reason',
      'Taxable',
      'CGST',
      'SGST',
      'IGST',
      'Round off',
      'Total',
    ],
    sql: `SELECT c.number, to_char(c.cn_date, 'YYYY-MM-DD'), i.number, i.client_name,
                 coalesce(i.client_gstin, ''), c.reason, c.taxable::text, c.cgst::text, c.sgst::text,
                 c.igst::text, c.round_off::text, c.total::text
            FROM credit_note c JOIN invoice i ON i.id = c.invoice_id
           WHERE c.cn_date BETWEEN $1 AND $2
           ORDER BY c.cn_date, c.number`,
  },
  {
    name: 'client-receipts',
    module: 'receipts',
    header: ['Number', 'Date', 'Client', 'Project', 'Against', 'Mode', 'Reference', 'Amount'],
    sql: `SELECT r.number, to_char(r.receipt_date, 'YYYY-MM-DD'), k.name, p.code,
                 coalesce((SELECT string_agg(coalesce(i.number, f.number), ', ')
                             FROM receipt_allocation x
                             LEFT JOIN invoice i ON i.id = x.invoice_id
                             LEFT JOIN proforma f ON f.id = x.proforma_id
                            WHERE x.receipt_id = r.id), ''),
                 r.mode, coalesce(r.reference, ''), r.amount::text
            FROM receipt r JOIN contact k ON k.id = r.client_id JOIN project p ON p.id = r.project_id
           WHERE r.deleted_at IS NULL AND r.receipt_date BETWEEN $1 AND $2
           ORDER BY r.receipt_date, r.number`,
  },
  {
    name: 'purchase-bills',
    module: 'bills',
    header: [
      'Bill number',
      'Date',
      'Due',
      'Vendor',
      'Vendor GSTIN',
      'Project',
      'Category',
      'GST rate',
      'ITC eligible',
      'Taxable',
      'CGST',
      'SGST',
      'IGST',
      'Round off',
      'Total',
    ],
    sql: `SELECT b.bill_no, to_char(b.bill_date, 'YYYY-MM-DD'), to_char(b.due_date, 'YYYY-MM-DD'),
                 b.vendor_name, coalesce(b.vendor_gstin, ''), p.code, b.category, b.gst_rate::text,
                 CASE WHEN b.itc_eligible THEN 'yes' ELSE 'no' END,
                 b.taxable::text, b.cgst::text, b.sgst::text, b.igst::text, b.round_off::text,
                 b.total::text
            FROM bill b JOIN project p ON p.id = b.project_id
           WHERE b.deleted_at IS NULL AND b.bill_date BETWEEN $1 AND $2
           ORDER BY b.bill_date, b.vendor_name, b.bill_no`,
  },
  {
    name: 'vendor-payments',
    module: 'bills',
    header: [
      'Date',
      'Vendor',
      'Bill number',
      'Project',
      'Mode',
      'Reference',
      'Amount',
      'TDS',
      'Status',
    ],
    sql: `SELECT to_char(v.pay_date, 'YYYY-MM-DD'), k.name, b.bill_no, p.code, v.mode,
                 coalesce(v.reference, ''), v.amount::text, v.tds::text, v.status
            FROM vendor_payment v
            JOIN contact k ON k.id = v.vendor_id
            JOIN bill b ON b.id = v.bill_id
            JOIN project p ON p.id = v.project_id
           WHERE v.deleted_at IS NULL AND v.pay_date BETWEEN $1 AND $2
           ORDER BY v.pay_date, k.name`,
  },
  {
    name: 'expenses',
    module: 'expenses',
    header: [
      'Date',
      'Project',
      'Particulars',
      'Category',
      'Paid by',
      'Mode',
      'Paid to',
      'Amount',
      'Status',
    ],
    sql: `SELECT to_char(e.txn_date, 'YYYY-MM-DD'), p.code, e.particulars, e.category, e.paid_by,
                 e.mode, coalesce(e.paid_to, ''), e.amount::text, e.status
            FROM expense e JOIN project p ON p.id = e.project_id
           WHERE e.deleted_at IS NULL AND e.txn_date BETWEEN $1 AND $2
           ORDER BY e.txn_date, e.created_at`,
  },
  {
    name: 'payroll',
    module: 'payroll',
    header: [
      'Month',
      'Pay date',
      'Employee',
      'Role',
      'Gross',
      'TDS',
      'Professional tax',
      'Advance recovery',
      'Net',
      'Run status',
    ],
    sql: `SELECT r.period, to_char(r.pay_date, 'YYYY-MM-DD'), s.name, s.role_title, s.gross::text,
                 s.tds::text, s.pt::text, s.recovery::text, s.net::text, r.status
            FROM payroll_run r JOIN payslip s ON s.run_id = r.id
           WHERE r.deleted_at IS NULL AND r.pay_date BETWEEN $1 AND $2
           ORDER BY r.pay_date, s.name`,
  },
  {
    name: 'chart-of-accounts',
    header: ['Code', 'Account', 'Type', 'Group', 'Active'],
    sql: `SELECT code, name, type, coalesce(subtype, ''), CASE WHEN is_active THEN 'yes' ELSE 'no' END
            FROM account ORDER BY code`,
    values: () => [],
  },
];

/**
 * The books for a period as plain CSV files, for the company's accountant: day book (every
 * journal line), trial balance, sales, credit notes, receipts, bills, vendor payments, expenses,
 * payroll and the chart of accounts. Needs reports + pnl across all projects (owner, auditor); each
 * document file also needs its own module right, so the ZIP never shows more than the screens do.
 * The export is audited (H4).
 */
export class AccountantExportService {
  constructor(private readonly pool: pg.Pool) {}

  async pack(
    actor: Actor,
    range: { from?: string | undefined; to?: string | undefined } = {},
  ): Promise<AccountantPack> {
    authorize(actor, 'reports', 'view');
    authorize(actor, 'pnl', 'view');
    if (projectScope(actor) !== null) {
      throw new DomainError('FORBIDDEN', 'This needs access to all projects.');
    }
    const to = range.to ?? todayIn();
    parseIsoDate(to, 'to');
    const sheets = SHEETS.filter((s) => !s.module || can(actor, s.module, 'view'));
    return withTenant(this.pool, ctx(actor), async (c) => {
      const co = await c.query<{ name: string; fy_start_month: number }>(
        'SELECT coalesce(legal_name, name) AS name, fy_start_month FROM company',
      );
      const company = co.rows[0];
      if (!company) throw new DomainError('NOT_FOUND', 'Company not found.');
      const from = range.from ?? financialYearStart(to, company.fy_start_month);
      parseIsoDate(from, 'from');
      if (from > to) {
        throw new DomainError('VALIDATION', 'The start date is after the end date.', 'from');
      }
      const files: AccountantFile[] = [];
      for (const sheet of sheets) {
        const { rows } = await c.query<string[]>({
          text: sheet.sql,
          values: sheet.values ? sheet.values(from, to) : [from, to],
          rowMode: 'array',
        });
        files.push({ name: sheet.name, rows: [sheet.header, ...rows] });
      }
      await writeAudit(c, {
        action: 'export',
        entity: 'accountant_pack',
        entityId: null,
        after: {
          format: 'csv-zip',
          from,
          to,
          files: Object.fromEntries(files.map((f) => [f.name, f.rows.length - 1])),
        },
      });
      return { company: company.name, from, to, files };
    });
  }
}
