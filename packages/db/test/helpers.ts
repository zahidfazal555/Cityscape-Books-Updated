import { inject } from 'vitest';
import pg from 'pg';

export const superPool = new pg.Pool({ connectionString: inject('superUrl'), max: 4 });
export const appPool = new pg.Pool({ connectionString: inject('appUrl'), max: 20 });
export const migratorPool = new pg.Pool({ connectionString: inject('migratorUrl'), max: 2 });

export async function closePools(): Promise<void> {
  await Promise.all([superPool.end(), appPool.end(), migratorPool.end()]);
}

export interface Fixture {
  companyId: string;
  ownerId: string;
  clientId: string;
  projectId: string;
}

let seq = 0;

/** Creates a company with its chart of accounts, an owner, a client and a project. */
export async function makeCompany(name = 'Cityscape Decors'): Promise<Fixture> {
  seq += 1;
  const c = await superPool.connect();
  try {
    await c.query('BEGIN');
    const company = await c.query<{ id: string }>(
      `INSERT INTO company (name) VALUES ($1) RETURNING id`,
      [`${name} ${seq}`],
    );
    const companyId = company.rows[0]!.id;
    await c.query('SELECT seed_company_accounts($1)', [companyId]);
    const owner = await c.query<{ id: string }>(
      `INSERT INTO app_user (company_id, name, email, role) VALUES ($1, 'Owner', $2, 'owner') RETURNING id`,
      [companyId, `owner${seq}.${Date.now()}@example.test`],
    );
    const client = await c.query<{ id: string }>(
      `INSERT INTO contact (company_id, type, name, state_code) VALUES ($1, 'client', 'Hire Nexa', '33') RETURNING id`,
      [companyId],
    );
    const project = await c.query<{ id: string }>(
      `INSERT INTO project (company_id, code, name, client_id, start_date)
       VALUES ($1, 'CSD-PRJ-0001', 'Office Interiors', $2, '2026-09-09') RETURNING id`,
      [companyId, client.rows[0]!.id],
    );
    await c.query('COMMIT');
    return {
      companyId,
      ownerId: owner.rows[0]!.id,
      clientId: client.rows[0]!.id,
      projectId: project.rows[0]!.id,
    };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
