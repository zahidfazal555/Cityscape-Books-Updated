import type { TestProject } from 'vitest/node';
import pg from 'pg';
import { migrate } from '../src/migrate.js';

/**
 * Creates a throwaway database owned by a NON-superuser migration role (as on managed
 * hosting), applies all migrations, and creates the app login role. Dropped afterwards.
 * Needs TEST_ADMIN_URL (a superuser), e.g. the CI Postgres service.
 */
const ADMIN_URL =
  process.env['TEST_ADMIN_URL'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';

declare module 'vitest' {
  export interface ProvidedContext {
    superUrl: string;
    appUrl: string;
    migratorUrl: string;
  }
}

const withDb = (url: string, db: string): string => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

const asUser = (url: string, user: string, password: string): string => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dbName = `csd_test_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'csd_migrator') THEN
        CREATE ROLE csd_migrator LOGIN CREATEROLE PASSWORD 'migrator';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'csd_app_login') THEN
        CREATE ROLE csd_app_login LOGIN PASSWORD 'app';
      END IF;
    END $$`);
  await admin.query(`CREATE DATABASE ${dbName} OWNER csd_migrator`);

  const migratorUrl = withDb(asUser(ADMIN_URL, 'csd_migrator', 'migrator'), dbName);
  await migrate(migratorUrl);
  await admin.query('GRANT csd_app TO csd_app_login');

  project.provide('superUrl', withDb(ADMIN_URL, dbName));
  project.provide('migratorUrl', migratorUrl);
  project.provide('appUrl', withDb(asUser(ADMIN_URL, 'csd_app_login', 'app'), dbName));

  return async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  };
}
