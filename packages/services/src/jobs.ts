import { withTenant } from '@csd/db';
import type pg from 'pg';
import { notifySla } from './tickets.js';

/**
 * Scheduled jobs (ENGINEERING-STANDARDS §6 worker duties), run from cron through `pnpm jobs`.
 * `admin` is a role that can see every company (the migration role); per-company writes go through
 * `withTenant` on the app pool, as the company's Owner, so RLS still applies.
 */
export interface JobPools {
  app: pg.Pool;
  admin: pg.Pool;
}

async function companies(admin: pg.Pool): Promise<{ id: string; owner: string; name: string }[]> {
  const { rows } = await admin.query<{ id: string; owner: string | null; name: string }>(
    `SELECT c.id, c.name, (SELECT u.id FROM app_user u WHERE u.company_id = c.id AND u.role = 'owner' LIMIT 1) AS owner
       FROM company c ORDER BY c.name`,
  );
  return rows.filter((r): r is { id: string; owner: string; name: string } => r.owner !== null);
}

/** SLA alerts for every company, also on nights when nobody opens the app (README §18). */
export async function slaSweep(p: JobPools): Promise<{ companies: number }> {
  const list = await companies(p.admin);
  for (const c of list) await withTenant(p.app, { companyId: c.id, userId: c.owner }, notifySla);
  return { companies: list.length };
}

/**
 * §9 retention: ticket caller name and phone are anonymised 3 years after closure. The ticket,
 * its thread and costs stay (books are kept 8 years).
 */
export async function anonymiseCallers(p: JobPools, years = 3): Promise<{ tickets: number }> {
  let n = 0;
  for (const c of await companies(p.admin)) {
    n += await withTenant(p.app, { companyId: c.id, userId: c.owner }, async (tx) => {
      const r = await tx.query(
        `UPDATE ticket SET caller_name = NULL, caller_phone = NULL, updated_by = app_user_id()
          WHERE status = 'closed' AND closed_at < now() - make_interval(years => $1)
            AND (caller_name IS NOT NULL OR caller_phone IS NOT NULL)`,
        [years],
      );
      return r.rowCount ?? 0;
    });
  }
  return { tickets: n };
}

export interface BooksCheck {
  companyId: string;
  company: string;
  ok: boolean;
  problems: string[];
}

/**
 * `pnpm verify:books` (RUNBOOKS §6 restore drill, and nightly): every journal balances, the trial
 * balance is zero, and numbered series have no gaps or duplicates. Read-only.
 */
export async function verifyBooks(admin: pg.Pool): Promise<BooksCheck[]> {
  const out: BooksCheck[] = [];
  for (const c of await companies(admin)) {
    const problems: string[] = [];
    const unbalanced = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT j.id FROM journal j JOIN journal_line l ON l.journal_id = j.id
          WHERE j.company_id = $1 GROUP BY j.id HAVING sum(l.debit) <> sum(l.credit)) x`,
      [c.id],
    );
    if (Number(unbalanced.rows[0]?.n) > 0)
      problems.push(`${unbalanced.rows[0]?.n} journals do not balance`);
    const tb = await admin.query<{ diff: string }>(
      `SELECT coalesce(sum(debit) - sum(credit), 0)::text AS diff FROM journal_line WHERE company_id = $1`,
      [c.id],
    );
    if (Number(tb.rows[0]?.diff) !== 0)
      problems.push(`trial balance is off by ${tb.rows[0]?.diff}`);
    const gaps = await admin.query<{ series: string; fy: string; n: string; top: string }>(
      `SELECT split_part(number, '/', 1) AS series, fy, count(*)::text AS n,
              max(split_part(number, '/', 3)::int)::text AS top
         FROM invoice WHERE company_id = $1 GROUP BY 1, 2`,
      [c.id],
    );
    for (const g of gaps.rows)
      if (g.n !== g.top)
        problems.push(
          `invoice series ${g.series}/${g.fy}: ${g.n} invoices, highest number ${g.top}`,
        );
    out.push({ companyId: c.id, company: c.name, ok: problems.length === 0, problems });
  }
  return out;
}

function checkBootstrap(input: { company: string; ownerName: string; ownerEmail: string }): string {
  const email = input.ownerEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Give the Owner a valid email.');
  if (!input.company.trim() || !input.ownerName.trim())
    throw new Error('Give the company and Owner names.');
  return email;
}

/**
 * First-time set-up (docs/GO-LIVE.md): the company, its chart of accounts and the Owner, who has no
 * password yet and sets one through "Forgot password" on the sign-in page. Refuses to run twice.
 */
export async function bootstrapCompany(
  admin: pg.Pool,
  input: { company: string; ownerName: string; ownerEmail: string; stateCode?: string },
): Promise<{ companyId: string; ownerId: string }> {
  const email = checkBootstrap(input);
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    const taken = await c.query(
      `SELECT 1 FROM company WHERE name = $1 UNION ALL SELECT 1 FROM app_user WHERE email = $2`,
      [input.company.trim(), email],
    );
    if (taken.rowCount) throw new Error('That company or Owner email already exists.');
    const co = await c.query<{ id: string }>(
      `INSERT INTO company (name, state_code) VALUES ($1, $2) RETURNING id`,
      [input.company.trim(), input.stateCode ?? '33'],
    );
    const companyId = co.rows[0]?.id;
    if (!companyId) throw new Error('The company was not created.');
    await c.query('SELECT seed_company_accounts($1)', [companyId]);
    const owner = await c.query<{ id: string }>(
      `INSERT INTO app_user (company_id, name, email, role) VALUES ($1, $2, $3, 'owner') RETURNING id`,
      [companyId, input.ownerName.trim(), email],
    );
    await c.query('COMMIT');
    const ownerId = owner.rows[0]?.id;
    if (!ownerId) throw new Error('The Owner was not created.');
    return { companyId, ownerId };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
