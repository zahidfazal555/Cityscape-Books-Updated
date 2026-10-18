import { randomUUID } from 'node:crypto';
import { SERIES, type Series } from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { notifySla } from './tickets.js';

/**
 * Scheduled jobs (ENGINEERING-STANDARDS §6 worker duties), run from cron through `pnpm jobs`.
 * They connect as the app role: the company list comes from `jobs_companies()` (0014), and all
 * per-company work runs inside that company's tenant, so row-level security still applies and no
 * superuser or BYPASSRLS role is needed (BUG-173). Only `bootstrap` uses the admin role.
 */
export interface JobCompany {
  id: string;
  name: string;
  ownerId: string;
}

export interface JobFailure {
  company: string;
  error: string;
}

/** Companies the jobs run for. An empty list is an error, never a silent success (BUG-173). */
export async function jobCompanies(app: pg.Pool): Promise<JobCompany[]> {
  const { rows } = await app.query<{ id: string; name: string; owner_id: string | null }>(
    'SELECT id, name, owner_id FROM jobs_companies()',
  );
  if (rows.length === 0)
    throw new Error('No companies are visible to the jobs. Check DATABASE_URL and migrations.');
  return rows.map((r) => ({ id: r.id, name: r.name, ownerId: r.owner_id ?? '' }));
}

/**
 * Runs `fn` for every company inside its tenant (as its Owner). One failing company does not
 * stop the others; failures are returned so the CLI exits 1 (BUG-178).
 */
async function eachCompany<T>(
  app: pg.Pool,
  fn: (c: pg.PoolClient, co: JobCompany) => Promise<T>,
): Promise<{ results: { company: JobCompany; value: T }[]; failures: JobFailure[] }> {
  const results: { company: JobCompany; value: T }[] = [];
  const failures: JobFailure[] = [];
  for (const co of await jobCompanies(app)) {
    if (!co.ownerId) {
      failures.push({ company: co.name, error: 'The company has no Owner.' });
      continue;
    }
    try {
      const value = await withTenant(app, { companyId: co.id, userId: co.ownerId }, (c) =>
        fn(c, co),
      );
      results.push({ company: co, value });
    } catch (e) {
      failures.push({ company: co.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { results, failures };
}

/** SLA alerts for every company, also on nights when nobody opens the app (README §18). */
export async function slaSweep(
  app: pg.Pool,
): Promise<{ companies: number; failures: JobFailure[] }> {
  const { results, failures } = await eachCompany(app, (c) => notifySla(c));
  return { companies: results.length, failures };
}

/**
 * §9 retention: ticket caller name and phone are anonymised 3 years after the ticket was
 * resolved or closed (BUG-179: a ticket left Resolved counts too). The ticket, its thread and
 * costs stay (books are kept 8 years).
 */
export async function anonymiseCallers(
  app: pg.Pool,
  years = 3,
): Promise<{ tickets: number; failures: JobFailure[] }> {
  const { results, failures } = await eachCompany(app, async (c) => {
    const r = await c.query(
      `UPDATE ticket SET caller_name = NULL, caller_phone = NULL, updated_by = app_user_id()
        WHERE status IN ('resolved', 'closed')
          AND coalesce(closed_at, resolved_at) < now() - make_interval(years => $1)
          AND (caller_name IS NOT NULL OR caller_phone IS NOT NULL)`,
      [years],
    );
    return r.rowCount ?? 0;
  });
  return { tickets: results.reduce((n, r) => n + r.value, 0), failures };
}

export interface BooksCheck {
  companyId: string;
  company: string;
  ok: boolean;
  problems: string[];
  /** Row counts and an invoice-series checksum, for comparing a restore with production. */
  counts: Record<string, number>;
  invoiceChecksum: string;
}

/** Where each numbered series lives (numbering.ts SERIES). */
const SERIES_TABLE: Record<Series, { table: string; column: string }> = {
  project: { table: 'project', column: 'code' },
  quote: { table: 'quotation', column: 'number' },
  proforma: { table: 'proforma', column: 'number' },
  invoice: { table: 'invoice', column: 'number' },
  creditNote: { table: 'credit_note', column: 'number' },
  receipt: { table: 'receipt', column: 'number' },
  purchaseOrder: { table: 'purchase_order', column: 'number' },
  ticket: { table: 'ticket', column: 'number' },
};

async function seriesProblems(c: pg.PoolClient): Promise<string[]> {
  const problems: string[] = [];
  const { rows } = await c.query<{ series: Series; period: string; next_value: number }>(
    'SELECT series, period, next_value FROM number_series',
  );
  for (const s of rows) {
    const where = SERIES_TABLE[s.series];
    const def = SERIES[s.series];
    if (!where || !def) continue;
    const prefix = def.fy ? `${def.prefix}${s.period}/` : def.prefix;
    const r = await c.query<{ n: number }>(
      `SELECT count(DISTINCT ${where.column})::int AS n FROM ${where.table} WHERE starts_with(${where.column}, $1)`,
      [prefix],
    );
    // Numbers are allocated gaplessly in the document's own transaction: every one issued exists.
    const issued = s.next_value - 1;
    const found = r.rows[0]?.n ?? 0;
    if (found !== issued)
      problems.push(`${s.series} ${s.period}: ${issued} numbers issued, ${found} documents found`);
  }
  return problems;
}

async function balanceProblems(c: pg.PoolClient): Promise<string[]> {
  const problems: string[] = [];
  const unbalanced = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (
       SELECT j.id FROM journal j JOIN journal_line l ON l.journal_id = j.id
        GROUP BY j.id HAVING sum(l.debit) <> sum(l.credit)) x`,
  );
  const n = unbalanced.rows[0]?.n ?? 0;
  if (n > 0) problems.push(`${n} journals do not balance`);
  const tb = await c.query<{ diff: string }>(
    `SELECT coalesce(sum(debit) - sum(credit), 0)::text AS diff FROM journal_line`,
  );
  const diff = tb.rows[0]?.diff ?? '0';
  if (Number(diff) !== 0) problems.push(`trial balance is off by ${diff}`);
  return problems;
}

async function checkCompany(c: pg.PoolClient): Promise<Omit<BooksCheck, 'companyId' | 'company'>> {
  const problems = await balanceProblems(c);
  problems.push(...(await seriesProblems(c)));
  const counts = await c.query<Record<string, number>>(
    `SELECT (SELECT count(*) FROM journal)::int AS journals, (SELECT count(*) FROM journal_line)::int AS lines,
            (SELECT count(*) FROM invoice)::int AS invoices, (SELECT count(*) FROM receipt)::int AS receipts,
            (SELECT count(*) FROM expense)::int AS expenses, (SELECT count(*) FROM attachment)::int AS attachments`,
  );
  const sum = await c.query<{ md5: string | null }>(
    `SELECT md5(string_agg(number || ':' || total::text || ':' || status, ',' ORDER BY number)) AS md5 FROM invoice`,
  );
  return {
    ok: problems.length === 0,
    problems,
    counts: counts.rows[0] ?? {},
    invoiceChecksum: sum.rows[0]?.md5 ?? '',
  };
}

/**
 * `pnpm verify:books` (RUNBOOKS §6 restore drill, and nightly): every journal balances, the trial
 * balance is zero, every numbered series matches its counter (no gaps, no missing latest
 * documents; BUG-176), plus row counts and an invoice checksum. Read-only.
 */
export async function verifyBooks(
  app: pg.Pool,
): Promise<{ checks: BooksCheck[]; failures: JobFailure[] }> {
  const { results, failures } = await eachCompany(app, (c) => checkCompany(c));
  return {
    checks: results.map((r) => ({ companyId: r.company.id, company: r.company.name, ...r.value })),
    failures,
  };
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
 * password yet and sets one through "Forgot password". Runs once: it refuses when any company
 * exists unless `another` is set (BUG-175), under an advisory lock, and writes an audit row.
 * Rows are written inside the new company's tenant, so the admin role needs no RLS bypass.
 */
export async function bootstrapCompany(
  admin: pg.Pool,
  input: {
    company: string;
    ownerName: string;
    ownerEmail: string;
    stateCode?: string;
    another?: boolean;
  },
): Promise<{ companyId: string; ownerId: string }> {
  const email = checkBootstrap(input);
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('csd:bootstrap'))`);
    const existing = await c.query('SELECT 1 FROM jobs_companies() LIMIT 1');
    if (existing.rowCount && !input.another)
      throw new Error(
        'A company already exists. Pass --another to create a second one on purpose.',
      );
    const taken = await c.query('SELECT 1 FROM auth_find_user($1)', [email]);
    if (taken.rowCount) throw new Error('That Owner email is already in use.');
    const companyId = randomUUID();
    const ownerId = randomUUID();
    await c.query(
      `SELECT set_config('app.company_id', $1, true), set_config('app.user_id', $2, true)`,
      [companyId, ownerId],
    );
    await c.query(`INSERT INTO company (id, name, state_code) VALUES ($1, $2, $3)`, [
      companyId,
      input.company.trim(),
      input.stateCode ?? '33',
    ]);
    await c.query('SELECT seed_company_accounts($1)', [companyId]);
    await c.query(
      `INSERT INTO app_user (id, company_id, name, email, role) VALUES ($1, $2, $3, $4, 'owner')`,
      [ownerId, companyId, input.ownerName.trim(), email],
    );
    await writeAudit(c, {
      action: 'bootstrap',
      entity: 'company',
      entityId: companyId,
      after: { ownerId },
    });
    await c.query('COMMIT');
    return { companyId, ownerId };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
