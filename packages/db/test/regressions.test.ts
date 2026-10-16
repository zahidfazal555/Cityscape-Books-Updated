import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  postJournal,
  redact,
  reverseJournal,
  withTenant,
  writeAudit,
  writeAuditDetached,
} from '../src/index.js';
import {
  appPool,
  closePools,
  makeCompany,
  migratorPool,
  superPool,
  type Fixture,
} from './helpers.js';
import { inject } from 'vitest';
import { migrate } from '../src/migrate.js';

let f: Fixture;
const ctx = (): { companyId: string; userId: string } => ({
  companyId: f.companyId,
  userId: f.ownerId,
});
const pair = (txnDate = '2026-10-14') => ({
  txnDate,
  sourceType: 'manual',
  narration: 'test',
  lines: [
    { accountCode: '5080', debit: 100_000_00, projectId: f.projectId },
    { accountCode: '1010', credit: 100_000_00 },
  ],
});

beforeAll(async () => {
  f = await makeCompany('Regressions');
});
afterAll(closePools);

describe('review regressions (db)', () => {
  it('BUG-001: no lines can be added to an already-posted journal, even balanced ones', async () => {
    const id = await withTenant(appPool, ctx(), (c) => postJournal(c, pair()));
    await expect(
      withTenant(appPool, ctx(), (c) =>
        c.query(
          `INSERT INTO journal_line (company_id, journal_id, account_id, debit, credit)
           SELECT app_company_id(), $1, id, CASE code WHEN '5000' THEN 100 ELSE 0 END,
                  CASE code WHEN '4000' THEN 100 ELSE 0 END
             FROM account WHERE code IN ('5000', '4000')`,
          [id],
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('BUG-001: a locked period cannot be changed by appending lines', async () => {
    const id = await withTenant(appPool, ctx(), (c) => postJournal(c, pair('2026-09-15')));
    await superPool.query(`UPDATE company SET lock_date = '2026-09-30' WHERE id = $1`, [
      f.companyId,
    ]);
    try {
      await expect(
        withTenant(appPool, ctx(), (c) =>
          c.query(
            `INSERT INTO journal_line (company_id, journal_id, account_id, debit)
             SELECT app_company_id(), $1, id, 1 FROM account WHERE code = '5000'`,
            [id],
          ),
        ),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await superPool.query('UPDATE company SET lock_date = NULL WHERE id = $1', [f.companyId]);
    }
  });

  it('BUG-002: the owner cannot be demoted or deleted, and the app cannot delete users', async () => {
    await expect(
      withTenant(appPool, ctx(), (c) =>
        c.query(`UPDATE app_user SET role = 'admin' WHERE id = $1`, [f.ownerId]),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      superPool.query('DELETE FROM app_user WHERE id = $1', [f.ownerId]),
    ).rejects.toThrow('cannot be deleted');
    await expect(
      withTenant(appPool, ctx(), (c) => c.query('DELETE FROM app_user WHERE id = $1', [f.ownerId])),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('BUG-003: a denied audit row survives the rollback of the request transaction', async () => {
    await expect(
      withTenant(appPool, ctx(), async (c) => {
        await writeAudit(c, {
          action: 'approve',
          entity: 'expense',
          outcome: 'denied',
          entityId: 'in-tx',
        });
        await writeAuditDetached(appPool, ctx(), {
          action: 'approve',
          entity: 'expense',
          outcome: 'denied',
          entityId: 'detached',
        });
        throw new Error('forbidden');
      }),
    ).rejects.toThrow('forbidden');
    const { rows } = await superPool.query<{ entity_id: string }>(
      `SELECT entity_id FROM audit_log WHERE company_id = $1 AND outcome = 'denied'`,
      [f.companyId],
    );
    expect(rows.map((r) => r.entity_id)).toEqual(['detached']);
  });

  it('BUG-005: audit snapshots keep timestamps', async () => {
    const at = new Date('2026-10-16T05:00:00Z');
    expect(JSON.stringify(redact({ last_login_at: at, password_hash: 'x' }))).toBe(
      '{"last_login_at":"2026-10-16T05:00:00.000Z","password_hash":"[redacted]"}',
    );
  });

  it('BUG-006: a journal can be reversed after one of its accounts is deactivated', async () => {
    const id = await withTenant(appPool, ctx(), (c) => postJournal(c, pair()));
    await superPool.query(
      `UPDATE account SET is_active = false WHERE company_id = $1 AND code = '5080'`,
      [f.companyId],
    );
    try {
      await expect(
        withTenant(appPool, ctx(), (c) => reverseJournal(c, id, '2026-10-20', 'Correction')),
      ).resolves.toBeTypeOf('string');
      await expect(withTenant(appPool, ctx(), (c) => postJournal(c, pair()))).rejects.toThrow(
        'Unknown account 5080',
      );
    } finally {
      await superPool.query(
        `UPDATE account SET is_active = true WHERE company_id = $1 AND code = '5080'`,
        [f.companyId],
      );
    }
  });

  it('BUG-007: a connection whose ROLLBACK failed is destroyed, not returned to the pool', async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'ROLLBACK') throw new Error('connection lost');
        return { rows: [] };
      }),
      release,
    };
    const pool = { connect: async () => client } as unknown as pg.Pool;
    await expect(
      withTenant(pool, ctx(), async () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ message: 'connection lost' }));
  });

  it('BUG-008: concurrent migrate runs are serialised and idempotent', async () => {
    const url = inject('migratorUrl');
    const [a, b] = await Promise.all([migrate(url), migrate(url)]);
    expect([...a, ...b]).toEqual([]);
    expect(migratorPool).toBeDefined();
  });

  it('BUG-009: the refresh flow can find its session by token hash without a tenant context', async () => {
    await superPool.query(
      `INSERT INTO session (company_id, user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, 'hash-abc', now() + interval '7 days')`,
      [f.companyId, f.ownerId],
    );
    const { rows } = await appPool.query('SELECT company_id, user_id FROM auth_find_session($1)', [
      'hash-abc',
    ]);
    expect(rows).toEqual([{ company_id: f.companyId, user_id: f.ownerId }]);
    expect((await appPool.query('SELECT * FROM session')).rows).toHaveLength(0);
  });
});

describe('second review regressions (db)', () => {
  it('BUG-013: revoked and expired sessions are never returned by the refresh lookup', async () => {
    await superPool.query(
      `INSERT INTO session (company_id, user_id, refresh_token_hash, expires_at, revoked_at) VALUES
         ($1, $2, 'hash-revoked', now() + interval '7 days', now()),
         ($1, $2, 'hash-expired', now() - interval '1 second', NULL)`,
      [f.companyId, f.ownerId],
    );
    for (const hash of ['hash-revoked', 'hash-expired', 'hash-unknown']) {
      expect((await appPool.query('SELECT * FROM auth_find_session($1)', [hash])).rows).toEqual([]);
    }
  });

  it('BUG-014: the owner role is isolated outside the auth functions; the app role cannot open the lookup', async () => {
    expect((await migratorPool.query('SELECT * FROM session')).rows).toHaveLength(0);
    expect((await migratorPool.query('SELECT * FROM app_user')).rows).toHaveLength(0);
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.auth_lookup', 'on', true)`);
      expect((await c.query('SELECT * FROM session')).rows).toHaveLength(0);
      expect((await c.query('SELECT * FROM app_user')).rows).toHaveLength(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('BUG-015: a caller-supplied posted_txid is overwritten with the real transaction id', async () => {
    await expect(
      withTenant(appPool, ctx(), async (c) => {
        const { rows } = await c.query<{ ok: boolean }>(
          `INSERT INTO journal (company_id, txn_date, source_type, narration, posted_txid)
           VALUES (app_company_id(), '2026-10-14', 'manual', 'forged',
                   ((pg_current_xact_id()::text)::bigint + 5)::text::xid8)
           RETURNING posted_txid = pg_current_xact_id() AS ok`,
        );
        expect(rows[0]).toEqual({ ok: true });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
  });

  it('BUG-016: Errors in audit snapshots keep name and message, and nested secrets are redacted', () => {
    const err = Object.assign(new Error('upstream failed'), {
      config: { headers: { authorization: 'Bearer x' } },
    });
    expect(redact({ after: err })).toEqual({
      after: {
        name: 'Error',
        message: 'upstream failed',
        config: { headers: { authorization: '[redacted]' } },
      },
    });
  });
});
