import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/index.js';
import { appPool, closePools, makeCompany, superPool, type Fixture } from './helpers.js';

let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  a = await makeCompany('Company A');
  b = await makeCompany('Company B');
});
afterAll(closePools);

describe('company isolation (RLS, handbook §7.1)', () => {
  it('a tenant sees only its own rows', async () => {
    const names = await withTenant(
      appPool,
      { companyId: a.companyId, userId: a.ownerId },
      async (c) => {
        const { rows } = await c.query<{ company_id: string }>('SELECT company_id FROM project');
        return rows.map((r) => r.company_id);
      },
    );
    expect(names).toEqual([a.companyId]);
  });

  it('cannot read another company even by id', async () => {
    const rows = await withTenant(
      appPool,
      { companyId: a.companyId, userId: a.ownerId },
      async (c) => (await c.query('SELECT * FROM project WHERE id = $1', [b.projectId])).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot write rows for another company', async () => {
    await expect(
      withTenant(appPool, { companyId: a.companyId, userId: a.ownerId }, (c) =>
        c.query(
          `INSERT INTO contact (company_id, type, name, state_code) VALUES ($1, 'vendor', 'X', '33')`,
          [b.companyId],
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('no tenant context means no rows at all', async () => {
    const c = await appPool.connect();
    try {
      expect((await c.query('SELECT * FROM project')).rows).toHaveLength(0);
      expect((await c.query('SELECT * FROM company')).rows).toHaveLength(0);
    } finally {
      c.release();
    }
  });

  it('rejects a malformed company id before touching the database', async () => {
    await expect(
      withTenant(appPool, { companyId: "x' OR 1=1 --", userId: null }, async () => 1),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('composite foreign keys stop cross-company references even without RLS', async () => {
    await expect(
      superPool.query(
        `INSERT INTO project (company_id, code, name, client_id, start_date)
         VALUES ($1, 'CSD-PRJ-0099', 'Cross', $2, '2026-10-01')`,
        [a.companyId, b.clientId],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('every company table has RLS enabled', async () => {
    const { rows } = await superPool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
          AND c.relname <> 'schema_migrations'`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});
