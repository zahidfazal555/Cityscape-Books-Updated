import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postJournal, reverseJournal, withTenant, type JournalInput } from '../src/index.js';
import { appPool, closePools, makeCompany, superPool, type Fixture } from './helpers.js';

let f: Fixture;
const ctx = (): { companyId: string; userId: string } => ({
  companyId: f.companyId,
  userId: f.ownerId,
});

const invoice = (overrides: Partial<JournalInput> = {}): JournalInput => ({
  txnDate: '2026-10-14',
  sourceType: 'invoice',
  narration: 'Tax invoice CSD/26-27/0001',
  lines: [
    { accountCode: '1100', debit: 1_180_000_00, contactId: f.clientId, projectId: f.projectId },
    { accountCode: '4000', credit: 1_000_000_00, projectId: f.projectId },
    { accountCode: '2200', credit: 90_000_00 },
    { accountCode: '2201', credit: 90_000_00 },
  ],
  ...overrides,
});

beforeAll(async () => {
  f = await makeCompany();
});
afterAll(closePools);

describe('balanced journal (guard-rail 1)', () => {
  it('posts a balanced journal', async () => {
    const id = await withTenant(appPool, ctx(), (c) => postJournal(c, invoice()));
    const { rows } = await superPool.query<{ dr: string; cr: string }>(
      'SELECT sum(debit)::text dr, sum(credit)::text cr FROM journal_line WHERE journal_id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ dr: '1180000.00', cr: '1180000.00' });
  });

  it('the app refuses an unbalanced journal with a 422', async () => {
    const bad = invoice({
      lines: [
        { accountCode: '1100', debit: 100 },
        { accountCode: '4000', credit: 99 },
      ],
    });
    await expect(withTenant(appPool, ctx(), (c) => postJournal(c, bad))).rejects.toMatchObject({
      status: 422,
    });
  });

  it('the database refuses an unbalanced journal even if the app check is bypassed', async () => {
    await expect(
      withTenant(appPool, ctx(), async (c) => {
        const j = await c.query<{ id: string }>(
          `INSERT INTO journal (company_id, txn_date, source_type, narration)
           VALUES (app_company_id(), '2026-10-14', 'manual', 'raw') RETURNING id`,
        );
        await c.query(
          `INSERT INTO journal_line (company_id, journal_id, account_id, debit)
           SELECT app_company_id(), $1, id, 100 FROM account WHERE code = '1000'`,
          [j.rows[0]!.id],
        );
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('the database refuses a journal with no lines', async () => {
    await expect(
      withTenant(appPool, ctx(), (c) =>
        c.query(`INSERT INTO journal (company_id, txn_date, source_type, narration)
                 VALUES (app_company_id(), '2026-10-14', 'manual', 'empty')`),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects unknown accounts', async () => {
    const bad = invoice({
      lines: [
        { accountCode: '9999', debit: 100 },
        { accountCode: '4000', credit: 100 },
      ],
    });
    await expect(withTenant(appPool, ctx(), (c) => postJournal(c, bad))).rejects.toThrow(
      'Unknown account 9999',
    );
  });
});

describe('immutability and reversals', () => {
  it('posted journals cannot be edited or deleted, even by the table owner', async () => {
    const id = await withTenant(appPool, ctx(), (c) => postJournal(c, invoice()));
    await expect(
      superPool.query(`UPDATE journal SET narration = 'x' WHERE id = $1`, [id]),
    ).rejects.toThrow('append-only');
    await expect(
      superPool.query('DELETE FROM journal_line WHERE journal_id = $1', [id]),
    ).rejects.toThrow('append-only');
  });

  it('a reversal mirrors the original, and a journal can be reversed only once', async () => {
    const id = await withTenant(appPool, ctx(), (c) => postJournal(c, invoice()));
    const rev = await withTenant(appPool, ctx(), (c) =>
      reverseJournal(c, id, '2026-10-15', 'Cancelled'),
    );
    const { rows } = await superPool.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, l.debit::text, l.credit::text FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.journal_id = $1 ORDER BY a.code`,
      [rev],
    );
    expect(rows).toContainEqual({ code: '1100', debit: '0.00', credit: '1180000.00' });
    expect(rows).toContainEqual({ code: '4000', debit: '1000000.00', credit: '0.00' });
    await expect(
      withTenant(appPool, ctx(), (c) => reverseJournal(c, id, '2026-10-16', 'Again')),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('lock date in the database (FR-3.3.1, UAT 6)', () => {
  it('refuses journals dated on or before the lock date with a 423', async () => {
    await superPool.query(`UPDATE company SET lock_date = '2026-09-30' WHERE id = $1`, [
      f.companyId,
    ]);
    try {
      for (const txnDate of ['2026-09-30', '2026-04-01']) {
        await expect(
          withTenant(appPool, ctx(), (c) => postJournal(c, invoice({ txnDate }))),
        ).rejects.toMatchObject({
          status: 423,
          message: 'Books are locked till 30 Sep 2026. Pick a later date.',
        });
      }
      await expect(
        withTenant(appPool, ctx(), (c) => postJournal(c, invoice({ txnDate: '2026-10-01' }))),
      ).resolves.toBeTypeOf('string');
    } finally {
      await superPool.query('UPDATE company SET lock_date = NULL WHERE id = $1', [f.companyId]);
    }
  });
});
