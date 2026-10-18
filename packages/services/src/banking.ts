import {
  DomainError,
  assertId,
  assertNotLocked,
  authorize,
  financialYear,
  fromDecimalString,
  projectScope,
  todayIn,
  type Actor,
  type IsoDate,
  type Paise,
} from '@csd/core';
import { postJournal, reverseJournal, withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { assertOwner } from './users.js';
import { companyRow, isoDate, parse, tenantOf as ctx } from './validation.js';

/** Cash in hand, bank current account, UPI (chart of accounts 0001; FR-13.1). */
export const MONEY_ACCOUNTS = ['1000', '1010', '1020'] as const;
/** Lines listed per register request; the closing balance is computed over all of them. */
export const REGISTER_LIMIT = 5000;

/** Lines whose journal was reversed, or that are a reversal: they need no statement tick (BUG-129). */
const REVERSED = `(j.reverses_journal_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM journal rj WHERE rj.reverses_journal_id = j.id))`;
export type MoneyAccount = (typeof MONEY_ACCOUNTS)[number];

export interface MoneyAccountCard {
  code: MoneyAccount;
  name: string;
  balance: Paise;
  unmatched: number;
}

export interface RegisterLine {
  lineId: string;
  date: IsoDate;
  particulars: string;
  sourceType: string;
  /** Receipt / payment / expense mode (bank, cheque, UPI, cash), where the document has one. */
  mode: string | null;
  /** A reversed entry or its reversal: the pair cancels and needs no statement match. */
  reversed: boolean;
  projectCode: string | null;
  moneyIn: Paise;
  moneyOut: Paise;
  balance: Paise;
  matched: boolean;
}

export interface Register {
  code: MoneyAccount;
  from: IsoDate;
  to: IsoDate;
  opening: Paise;
  closing: Paise;
  lines: RegisterLine[];
  unmatched: number;
  /** True when the range has more lines than are listed; the closing balance is still exact. */
  truncated: boolean;
}

const rangeSchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const openingSchema = z.object({
  code: z.enum(MONEY_ACCOUNTS),
  /** Signed paise: a bank overdraft is negative. */
  amount: z.number().int(),
  asOf: isoDate,
});

/**
 * Cash, bank & UPI registers (Req §4.13). Balances are the journal itself; the statement-match
 * tick is kept beside it. Company-wide figures, so they need access to every project.
 */
export class BankingService {
  constructor(private readonly pool: pg.Pool) {}

  async accounts(actor: Actor): Promise<MoneyAccountCard[]> {
    assertCompanyWide(actor, 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{
        code: MoneyAccount;
        name: string;
        balance: string;
        unmatched: string;
      }>(
        `SELECT a.code, a.name, coalesce(sum(l.debit - l.credit), 0)::text AS balance,
                count(l.id) FILTER (WHERE l.id IS NOT NULL AND m.journal_line_id IS NULL AND NOT ${REVERSED})::text
                  AS unmatched
           FROM account a
           LEFT JOIN journal_line l ON l.account_id = a.id
           LEFT JOIN journal j ON j.id = l.journal_id
           LEFT JOIN bank_match m ON m.journal_line_id = l.id
          WHERE a.code = ANY($1::text[])
          GROUP BY a.code, a.name ORDER BY a.code`,
        [MONEY_ACCOUNTS],
      );
      return rows.map((r) => ({
        code: r.code,
        name: r.name,
        balance: fromDecimalString(r.balance),
        unmatched: Number(r.unmatched),
      }));
    });
  }

  /** FR-13.2: one account's lines with a running balance; the current FY unless a range is given. */
  async register(
    actor: Actor,
    code: MoneyAccount,
    range: z.input<typeof rangeSchema> = {},
  ): Promise<Register> {
    assertCompanyWide(actor, 'view');
    const r = parse(rangeSchema, range);
    if (!MONEY_ACCOUNTS.includes(code)) throw new DomainError('NOT_FOUND', 'Account not found.');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const company = await companyRow(c);
      const to = r.to ?? todayIn();
      const from = r.from ?? fyStart(to, company.fy_start_month);
      const open = await c.query<{ opening: string }>(
        `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS opening
           FROM journal_line l JOIN account a ON a.id = l.account_id JOIN journal j ON j.id = l.journal_id
          WHERE a.code = $1 AND j.txn_date < $2`,
        [code, from],
      );
      const opening = fromDecimalString(open.rows[0]?.opening ?? '0');
      const rows = await registerRows(c, code, from, to);
      // BUG-127: the closing balance is summed in SQL, so a long range is never wrong, only shortened.
      const close = await c.query<{ closing: string }>(
        `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS closing
           FROM journal_line l JOIN account a ON a.id = l.account_id JOIN journal j ON j.id = l.journal_id
          WHERE a.code = $1 AND j.txn_date <= $2`,
        [code, to],
      );
      const truncated = rows.length > REGISTER_LIMIT;
      let balance = opening;
      const lines = rows.slice(0, REGISTER_LIMIT).map((x): RegisterLine => {
        const moneyIn = fromDecimalString(x.debit);
        const moneyOut = fromDecimalString(x.credit);
        balance += moneyIn - moneyOut;
        return {
          lineId: x.line_id,
          date: x.date,
          particulars: x.narration,
          sourceType: x.source_type,
          mode: x.mode,
          reversed: x.reversed,
          projectCode: x.project_code,
          moneyIn,
          moneyOut,
          balance,
          matched: x.matched,
        };
      });
      return {
        code,
        from,
        to,
        opening,
        closing: fromDecimalString(close.rows[0]?.closing ?? '0'),
        lines,
        unmatched: lines.filter((l) => !l.matched && !l.reversed).length,
        truncated,
      };
    });
  }

  /** Ticks or unticks a register line as matched with the bank/UPI statement. */
  async setMatched(actor: Actor, lineId: string, matched: boolean): Promise<void> {
    assertId(lineId, 'Line');
    assertCompanyWide(actor, 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{ code: string }>(
        `SELECT a.code FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.id = $1`,
        [lineId],
      );
      if (!rows[0] || !(MONEY_ACCOUNTS as readonly string[]).includes(rows[0].code))
        throw new DomainError('NOT_FOUND', 'Register line not found.');
      if (matched) {
        await c.query(
          `INSERT INTO bank_match (journal_line_id, company_id, matched_by) VALUES ($1, app_company_id(), app_user_id())
           ON CONFLICT (journal_line_id) DO NOTHING`,
          [lineId],
        );
      } else {
        await c.query('DELETE FROM bank_match WHERE journal_line_id = $1', [lineId]);
      }
      await writeAudit(c, {
        action: matched ? 'match' : 'unmatch',
        entity: 'journal_line',
        entityId: lineId,
      });
    });
  }

  /**
   * FR-13.1: the Owner enters each account's opening balance (Dr account / Cr opening balance
   * equity, or the reverse for an overdraft). Entering it again reverses the previous one.
   */
  async setOpening(actor: Actor, input: z.input<typeof openingSchema>): Promise<void> {
    assertOwner(actor);
    const data = parse(openingSchema, input);
    await withTenant(this.pool, ctx(actor), async (c) => {
      const company = await companyRow(c);
      assertNotLocked(data.asOf, company.lock_date, 'asOf');
      const acct = await c.query<{ id: string }>('SELECT id FROM account WHERE code = $1', [
        data.code,
      ]);
      const accountId = acct.rows[0]?.id;
      if (!accountId) throw new DomainError('NOT_FOUND', 'Account not found.');
      // Lock the account row: two concurrent entries cannot both find "no opening yet".
      // Only the live opening is replaced: never an earlier reversal of it (BUG-125).
      await c.query('SELECT 1 FROM account WHERE id = $1 FOR UPDATE', [accountId]);
      const prev = await c.query<{ id: string; date: string }>(
        `SELECT j.id, to_char(j.txn_date, 'YYYY-MM-DD') AS date FROM journal j
          WHERE j.source_type = 'opening_balance' AND j.source_id = $1 AND j.reverses_journal_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM journal r WHERE r.reverses_journal_id = j.id)`,
        [accountId],
      );
      for (const p of prev.rows) {
        assertNotLocked(p.date, company.lock_date, 'asOf');
        // On the old opening's own date (BUG-126): the periods in between never show both.
        await reverseJournal(c, p.id, p.date, `Opening balance of ${data.code} replaced`);
      }
      if (data.amount !== 0) {
        const debit = data.amount > 0;
        const amt = Math.abs(data.amount);
        await postJournal(c, {
          txnDate: data.asOf,
          sourceType: 'opening_balance',
          sourceId: accountId,
          narration: `Opening balance`,
          lines: [
            { accountCode: data.code, ...(debit ? { debit: amt } : { credit: amt }) },
            { accountCode: '3100', ...(debit ? { credit: amt } : { debit: amt }) },
          ],
        });
      }
      await writeAudit(c, {
        action: 'opening_balance',
        entity: 'account',
        entityId: accountId,
        after: data,
      });
    });
  }

  /** FR-13.3: approved spends by "Paid by" label, split UPI / Cash / Bank. */
  async spendByStaff(
    actor: Actor,
    range: z.input<typeof rangeSchema> = {},
  ): Promise<{ paidBy: string; upi: Paise; cash: Paise; bank: Paise; total: Paise }[]> {
    assertCompanyWide(actor, 'view');
    const r = parse(rangeSchema, range);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const company = await companyRow(c);
      const to = r.to ?? todayIn();
      const from = r.from ?? fyStart(to, company.fy_start_month);
      const { rows } = await c.query<{ paid_by: string; mode: string; total: string }>(
        `SELECT paid_by, mode, sum(amount)::text AS total FROM (
           SELECT paid_by, mode, amount FROM expense
            WHERE status = 'approved' AND deleted_at IS NULL AND txn_date BETWEEN $1 AND $2
           UNION ALL
           SELECT coalesce(paid_by, 'Unspecified'), CASE WHEN mode = 'cheque' THEN 'bank' ELSE mode END,
                  amount - tds
             FROM vendor_payment
            WHERE status = 'approved' AND deleted_at IS NULL AND pay_date BETWEEN $1 AND $2
         ) x GROUP BY paid_by, mode`,
        [from, to],
      );
      const by = new Map<
        string,
        { paidBy: string; upi: Paise; cash: Paise; bank: Paise; total: Paise }
      >();
      for (const x of rows) {
        const cur = by.get(x.paid_by) ?? { paidBy: x.paid_by, upi: 0, cash: 0, bank: 0, total: 0 };
        const amt = fromDecimalString(x.total);
        const mode = x.mode as 'upi' | 'cash' | 'bank';
        cur[mode] += amt;
        cur.total += amt;
        by.set(x.paid_by, cur);
      }
      return [...by.values()].sort((a, b) => b.total - a.total);
    });
  }
}

/** Company-wide books: a user limited to some projects cannot see whole-company balances. */
export function assertCompanyWide(
  actor: Actor,
  level: 'view' | 'edit',
  module: 'banking' | 'gst' = 'banking',
): void {
  authorize(actor, module, level);
  if (projectScope(actor) !== null) {
    throw new DomainError('FORBIDDEN', 'This needs access to all projects.');
  }
}

export function fyStart(date: IsoDate, startMonth: number): IsoDate {
  const fy = financialYear(date, startMonth);
  const y = 2000 + Number(fy.slice(0, 2));
  return `${y}-${String(startMonth).padStart(2, '0')}-01`;
}

interface RegisterRow {
  line_id: string;
  date: string;
  narration: string;
  source_type: string;
  project_code: string | null;
  debit: string;
  credit: string;
  matched: boolean;
  reversed: boolean;
  mode: string | null;
}

/** The register's lines in posting order, one more than the limit to detect truncation. */
async function registerRows(
  c: pg.PoolClient,
  code: MoneyAccount,
  from: IsoDate,
  to: IsoDate,
): Promise<RegisterRow[]> {
  const { rows } = await c.query<RegisterRow>(
    `SELECT l.id AS line_id, to_char(j.txn_date, 'YYYY-MM-DD') AS date, j.narration, j.source_type,
                p.code AS project_code, l.debit::text, l.credit::text, (m.journal_line_id IS NOT NULL) AS matched,
                ${REVERSED} AS reversed,
                coalesce(rc.mode, vp.mode, ex.mode) AS mode
           FROM journal_line l
           JOIN account a ON a.id = l.account_id
           JOIN journal j ON j.id = l.journal_id
           LEFT JOIN project p ON p.id = l.project_id
           LEFT JOIN bank_match m ON m.journal_line_id = l.id
           LEFT JOIN receipt rc ON j.source_type = 'receipt' AND rc.id = j.source_id
           LEFT JOIN vendor_payment vp ON j.source_type = 'vendor_payment' AND vp.id = j.source_id
           LEFT JOIN expense ex ON j.source_type = 'expense' AND ex.id = j.source_id
          WHERE a.code = $1 AND j.txn_date BETWEEN $2 AND $3
          ORDER BY j.txn_date, j.posted_at, l.id
          LIMIT ${REGISTER_LIMIT + 1}`,
    [code, from, to],
  );
  return rows;
}
