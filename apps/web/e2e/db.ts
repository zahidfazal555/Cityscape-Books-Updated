import pg from 'pg';
import { hashPassword } from '@csd/services';
import { E2E_DB } from '../playwright.config';

const ADMIN =
  process.env['TEST_ADMIN_URL'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';

/** Superuser access to the e2e database, for steps a real user would do by email (invites). */
export async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const u = new URL(ADMIN);
  u.pathname = `/${E2E_DB}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Stands in for "user opened the invite email and set a password". */
export async function acceptInvite(email: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await withDb((c) =>
    c.query('UPDATE app_user SET password_hash = $2 WHERE email = $1', [email, hash]),
  );
}
