import pg from 'pg';
import { migrate } from '@csd/db/migrate';
import { hashPassword } from '@csd/services';
import { E2E_DB } from '../playwright.config';
import { PASSWORD, USERS } from './fixtures';

const ADMIN =
  process.env['TEST_ADMIN_URL'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const at = (url: string, db: string, user?: [string, string]) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) [u.username, u.password] = user;
  return u.toString();
};

/** Fresh database with synthetic users only (no real client data — ENGINEERING-STANDARDS §3). */
export default async function globalSetup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'csd_migrator') THEN CREATE ROLE csd_migrator LOGIN CREATEROLE PASSWORD 'migrator'; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'csd_app_login') THEN CREATE ROLE csd_app_login LOGIN PASSWORD 'app'; END IF;
    END $$`);
  await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${E2E_DB} OWNER csd_migrator`);
  await migrate(at(ADMIN, E2E_DB, ['csd_migrator', 'migrator']));
  await admin.query('GRANT csd_app TO csd_app_login');
  await admin.end();

  const db = new pg.Client({ connectionString: at(ADMIN, E2E_DB) });
  await db.connect();
  const hash = await hashPassword(PASSWORD);
  const {
    rows: [company],
  } = await db.query<{ id: string }>(
    `INSERT INTO company (name, lock_date) VALUES ('Cityscape Decors (E2E)', '2026-09-30') RETURNING id`,
  );
  await db.query('SELECT seed_company_accounts($1)', [company!.id]);
  const ids: Record<string, string> = {};
  for (const u of USERS) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO app_user (company_id, name, email, role, password_hash, projects_all) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [company!.id, u.name, u.email, u.role, hash, u.role !== 'site'],
    );
    ids[u.role] = rows[0]!.id;
  }
  const {
    rows: [client],
  } = await db.query<{ id: string }>(
    `INSERT INTO contact (company_id, type, name, state_code) VALUES ($1, 'client', 'Hire Nexa Pvt Ltd', '33') RETURNING id`,
    [company!.id],
  );
  for (const [code, name] of [
    ['CSD-PRJ-0001', 'Hire Nexa Office Interiors'],
    ['CSD-PRJ-0002', 'Anand Residence 3BHK'],
  ]) {
    const {
      rows: [p],
    } = await db.query<{ id: string }>(
      `INSERT INTO project (company_id, code, name, client_id, start_date) VALUES ($1, $2, $3, $4, '2026-09-09') RETURNING id`,
      [company!.id, code, name, client!.id],
    );
    if (code === 'CSD-PRJ-0001') {
      await db.query(
        'INSERT INTO user_project (company_id, user_id, project_id) VALUES ($1, $2, $3)',
        [company!.id, ids['site'], p!.id],
      );
    }
  }
  await db.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 3)`, [company!.id]);
  await db.end();
}
