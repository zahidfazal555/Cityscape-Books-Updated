import {
  DomainError,
  fromDecimalString,
  toDecimalString,
  type IsoDate,
  type Paise,
} from '@csd/core';
import type pg from 'pg';

export interface JournalLineInput {
  accountCode: string;
  debit?: Paise;
  credit?: Paise;
  projectId?: string | null;
  contactId?: string | null;
}

export interface JournalInput {
  txnDate: IsoDate;
  sourceType: string;
  sourceId?: string | null;
  narration: string;
  lines: JournalLineInput[];
  reversesJournalId?: string | null;
}

/** Checks balance in the app first for a clear 422; the database checks again at commit. */
export function assertBalanced(lines: readonly JournalLineInput[]): void {
  if (lines.length < 2) throw new DomainError('VALIDATION', 'A journal needs at least two lines.');
  let dr = 0;
  let cr = 0;
  for (const l of lines) {
    const d = l.debit ?? 0;
    const c = l.credit ?? 0;
    if (d < 0 || c < 0 || (d === 0) === (c === 0)) {
      throw new DomainError('VALIDATION', 'Each journal line needs exactly one positive side.');
    }
    dr += d;
    cr += c;
  }
  if (dr !== cr) throw new DomainError('VALIDATION', 'Journal does not balance.');
}

async function insertLine(
  client: pg.PoolClient,
  journalId: string,
  line: JournalLineInput,
  allowInactive: boolean,
): Promise<void> {
  const res = await client.query(
    `INSERT INTO journal_line (company_id, journal_id, account_id, project_id, contact_id, debit, credit)
     SELECT app_company_id(), $1, a.id, $3, $4, $5, $6 FROM account a WHERE a.code = $2 AND (a.is_active OR $7)`,
    [
      journalId,
      line.accountCode,
      line.projectId ?? null,
      line.contactId ?? null,
      toDecimalString(line.debit ?? 0),
      toDecimalString(line.credit ?? 0),
      allowInactive,
    ],
  );
  if (res.rowCount !== 1) {
    throw new DomainError('VALIDATION', `Unknown account ${line.accountCode}.`, 'accountCode');
  }
}

/**
 * Posts one balanced journal in the caller's transaction and returns its id. New postings must
 * use active accounts; reversals may use accounts deactivated since the original was posted.
 */
export async function postJournal(client: pg.PoolClient, input: JournalInput): Promise<string> {
  return insertJournal(client, input, false);
}

async function insertJournal(
  client: pg.PoolClient,
  input: JournalInput,
  allowInactive: boolean,
): Promise<string> {
  assertBalanced(input.lines);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal (company_id, txn_date, source_type, source_id, narration, reverses_journal_id, posted_by)
     VALUES (app_company_id(), $1, $2, $3, $4, $5, app_user_id()) RETURNING id`,
    [
      input.txnDate,
      input.sourceType,
      input.sourceId ?? null,
      input.narration,
      input.reversesJournalId ?? null,
    ],
  );
  const journalId = rows[0]?.id;
  if (journalId === undefined) throw new Error('journal insert returned no id');
  for (const line of input.lines) await insertLine(client, journalId, line, allowInactive);
  return journalId;
}

/** Corrections never edit a posted journal: they post its mirror image. */
export async function reverseJournal(
  client: pg.PoolClient,
  journalId: string,
  txnDate: IsoDate,
  narration: string,
  /** Tag the reversal as its own document (e.g. a credit note) instead of the original's source. */
  source?: { sourceType: string; sourceId: string },
): Promise<string> {
  const head = await client.query<{ source_type: string; source_id: string | null }>(
    'SELECT source_type, source_id FROM journal WHERE id = $1',
    [journalId],
  );
  const original = head.rows[0];
  if (!original) throw new DomainError('NOT_FOUND', 'Journal not found.');
  const { rows } = await client.query<{
    code: string;
    project_id: string | null;
    contact_id: string | null;
    debit: string;
    credit: string;
  }>(
    `SELECT a.code, l.project_id, l.contact_id, l.debit::text, l.credit::text
       FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.journal_id = $1`,
    [journalId],
  );
  return insertJournal(
    client,
    {
      txnDate,
      sourceType: source?.sourceType ?? original.source_type,
      sourceId: source?.sourceId ?? original.source_id,
      narration,
      reversesJournalId: journalId,
      lines: rows.map((r) => ({
        accountCode: r.code,
        projectId: r.project_id,
        contactId: r.contact_id,
        debit: fromDecimalString(r.credit),
        credit: fromDecimalString(r.debit),
      })),
    },
    true,
  );
}
