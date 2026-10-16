import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redact, withTenant, writeAudit } from '../src/index.js';
import { appPool, closePools, makeCompany, superPool, type Fixture } from './helpers.js';

let f: Fixture;
beforeAll(async () => {
  f = await makeCompany();
});
afterAll(closePools);

describe('audit log is append-only (FR-3.3.3)', () => {
  it('writes rows with company and user from the context, and redacts secrets', async () => {
    await withTenant(appPool, { companyId: f.companyId, userId: f.ownerId }, (c) =>
      writeAudit(c, {
        action: 'update',
        entity: 'user',
        entityId: 'u1',
        before: { password: 'x' },
        after: { name: 'A' },
      }),
    );
    const { rows } = await superPool.query(
      `SELECT company_id, user_id, before, after FROM audit_log WHERE company_id = $1`,
      [f.companyId],
    );
    expect(rows[0]).toMatchObject({
      company_id: f.companyId,
      user_id: f.ownerId,
      before: { password: '[redacted]' },
      after: { name: 'A' },
    });
  });

  it('the app role has no UPDATE or DELETE grant', async () => {
    await expect(
      withTenant(appPool, { companyId: f.companyId, userId: f.ownerId }, (c) =>
        c.query('DELETE FROM audit_log'),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('even the owner role is blocked by trigger, including TRUNCATE', async () => {
    await expect(superPool.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(
      'append-only',
    );
    await expect(superPool.query('TRUNCATE audit_log')).rejects.toThrow('append-only');
  });

  it('redact walks nested objects and arrays', () => {
    expect(redact([{ refreshToken: 't', ok: { apiSecret: 's', n: 1 } }])).toEqual([
      { refreshToken: '[redacted]', ok: { apiSecret: '[redacted]', n: 1 } },
    ]);
  });
});

describe('users, rights and sign-in helpers', () => {
  it('allows only one owner per company and the owner cannot be deactivated', async () => {
    await expect(
      superPool.query(
        `INSERT INTO app_user (company_id, name, email, role) VALUES ($1, 'O2', 'o2@x.test', 'owner')`,
        [f.companyId],
      ),
    ).rejects.toThrow(/app_user_one_owner/);
    await expect(
      superPool.query('UPDATE app_user SET is_active = false WHERE id = $1', [f.ownerId]),
    ).rejects.toThrow(/owner_always_active/);
  });

  it('auditor accounts must expire', async () => {
    await expect(
      superPool.query(
        `INSERT INTO app_user (company_id, name, email, role) VALUES ($1, 'CA', 'ca@x.test', 'auditor')`,
        [f.companyId],
      ),
    ).rejects.toThrow(/check/);
  });

  it('permission rows only accept levels the module allows', async () => {
    const insert = (module: string, level: string): Promise<unknown> =>
      superPool.query(
        'INSERT INTO user_permission (company_id, user_id, module, level) VALUES ($1, $2, $3, $4)',
        [f.companyId, f.ownerId, module, level],
      );
    await expect(insert('approvals', 'view')).rejects.toThrow(/check/);
    await expect(insert('pnl', 'full')).rejects.toThrow(/check/);
    await expect(insert('users', 'full')).rejects.toThrow(/check/);
    await expect(insert('invoices', 'edit')).resolves.toBeDefined();
  });

  it('sign-in lookup works for the app role without a tenant context', async () => {
    const {
      rows: [owner],
    } = await superPool.query<{ email: string }>('SELECT email FROM app_user WHERE id = $1', [
      f.ownerId,
    ]);
    const { rows } = await appPool.query('SELECT id, company_id, role FROM auth_find_user($1)', [
      owner!.email.toUpperCase(),
    ]);
    expect(rows).toEqual([{ id: f.ownerId, company_id: f.companyId, role: 'owner' }]);
  });

  it('the app role cannot read users without a tenant context', async () => {
    expect((await appPool.query('SELECT * FROM app_user')).rows).toHaveLength(0);
  });

  it('five failed sign-ins lock the account for 15 minutes', async () => {
    let lockedUntil: Date | null = null;
    for (let i = 0; i < 5; i++) {
      const { rows } = await appPool.query<{ t: Date | null }>(
        'SELECT auth_record_failure($1) AS t',
        [f.ownerId],
      );
      lockedUntil = rows[0]!.t;
      if (i < 4) expect(lockedUntil).toBeNull();
    }
    const minutes = ((lockedUntil?.getTime() ?? 0) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
  });
});
