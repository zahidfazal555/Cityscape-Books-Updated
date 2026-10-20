import {
  AGEING_BUCKETS,
  DomainError,
  CATEGORY_ACCOUNT,
  COST_CATEGORIES,
  ageingBucket,
  assertId,
  authorize,
  can,
  canApprove,
  daysOverdue,
  financialYearStart,
  fromDecimalString,
  projectScope,
  todayIn,
  type Actor,
  type AgeingBucket,
  type CostCategory,
  type IsoDate,
  type Paise,
} from '@csd/core';
import { withTenant } from '@csd/db';
import type pg from 'pg';
import { ApprovalsService } from './approvals.js';
import { COST_ACCOUNTS, budgetLevel, type BudgetLevel } from './budget-alerts.js';
import { MONEY_ACCOUNTS } from './banking.js';
import { companyRow, tenantOf as ctx } from './validation.js';

type Scope = readonly string[] | null;

export interface DashboardAlert {
  kind: 'approvals' | 'budget';
  tone: 'amber' | 'red';
  text: string;
  href: string;
}

export interface DashboardKpis {
  receivables: Paise;
  payables: Paise;
  /** Only with the `banking` right (and all projects). */
  cashAndBank: Paise | null;
  /** Approvers see what waits for them; everyone else sees what was collected this year. */
  waitingApproval: number | null;
  collectedThisYear: Paise | null;
}

export interface DashboardProject {
  projectId: string;
  code: string;
  name: string;
  clientName: string;
  /** Tax invoices raised, with GST, cancelled ones excluded. */
  invoiceValue: Paise;
  /** Received from the client (Cr). */
  income: Paise;
  /** Posted project costs (Dr): approved expenses, bills, wages and contracts. */
  expense: Paise;
  /** Income less expense: only with `pnl` (Tech Spec §5). */
  net?: Paise;
  costBudget: Paise;
  /** Share of the cost budget used, in basis points (0 without a budget), for display. */
  budgetUsedBp: number;
  /** Amber from 85%, red above 100%, on exact paise (BUG-199). */
  level: BudgetLevel;
}

export interface Dashboard {
  alerts: DashboardAlert[];
  kpis: DashboardKpis;
  projects: DashboardProject[];
  spendByCategory: Record<CostCategory, Paise>;
  ageing: Record<AgeingBucket, Paise>;
}

/**
 * The home screen (README §2, Tech Spec `GET /dashboard`). Figures come from posted documents
 * and the journal only, so pending entries never show; everything follows the user's project
 * scope, and banking and profit figures follow their rights.
 */
export class DashboardService {
  private readonly approvals: ApprovalsService;

  constructor(private readonly pool: pg.Pool) {
    this.approvals = new ApprovalsService(pool);
  }

  /** Drill-down behind one or more "Spend by category" slices. */
  async spend(
    actor: Actor,
    categories: readonly CostCategory[],
    projectId?: string,
  ): Promise<SpendDetail> {
    return spendDetail(this.pool, actor, categories, projectId);
  }

  /** The charts on a project page (spend split, budget and billing, six-month trend). */
  async project(actor: Actor, projectId: string): Promise<ProjectCharts> {
    return projectCharts(this.pool, actor, projectId);
  }

  async summary(actor: Actor): Promise<Dashboard> {
    authorize(actor, 'dashboard', 'view');
    const waiting = canApprove(actor) ? await this.approvals.count(actor) : null;
    const data = await withTenant(this.pool, ctx(actor), async (c) => {
      const scope = projectScope(actor);
      return {
        // The per-project money columns need the projects right too (BUG-200).
        projects: can(actor, 'projects', 'view') ? await projectRows(c, scope) : [],
        receivables: await receivables(c, scope),
        payables: await sumOf(c, PAYABLES, scope),
        cashAndBank: can(actor, 'banking', 'view') && scope === null ? await cashAndBank(c) : null,
        collected: waiting === null ? await collectedThisYear(c, scope) : null,
        spend: await spendByCategory(c, scope),
      };
    });
    const pnl = can(actor, 'pnl', 'view');
    return {
      alerts: alertsFor(waiting, data.projects),
      kpis: {
        receivables: data.receivables.total,
        payables: data.payables,
        cashAndBank: data.cashAndBank,
        waitingApproval: waiting,
        collectedThisYear: data.collected,
      },
      projects: pnl ? data.projects : data.projects.map(({ net: _net, ...p }) => p),
      spendByCategory: data.spend,
      ageing: data.receivables.buckets,
    };
  }
}

export interface SpendEntry {
  date: IsoDate;
  particulars: string;
  category: CostCategory;
  projectId: string;
  projectCode: string;
  amount: Paise;
}

/** What makes up a slice of "Spend by category": by project, by category, and the entries. */
export interface SpendDetail {
  categories: CostCategory[];
  total: Paise;
  byCategory: { category: CostCategory; amount: Paise }[];
  byProject: { projectId: string; code: string; name: string; amount: Paise }[];
  entries: SpendEntry[];
  /** More entries exist than are listed; the totals above still cover all of them. */
  truncated: boolean;
}

const ENTRY_LIMIT = 300;
/** Wage, contract and salary postings name a person: only the payroll right sees who. */
const PAYROLL_SOURCES = ['wage_payment', 'contract_payment', 'payroll_run'];

/**
 * Journals on the categories' cost accounts in the caller's scope. An edit or deletion posts a
 * reversal of the same source; the pair nets to zero and is left out of the entry list.
 */
const SPEND_LINES = `
  SELECT to_char(j.txn_date, 'YYYY-MM-DD') AS date, j.narration, j.source_type, a.code,
         p.id AS project_id, p.code AS project_code, p.name AS project_name,
         (sum(l.debit) - sum(l.credit))::text AS net
    FROM journal_line l
    JOIN journal j ON j.id = l.journal_id
    JOIN account a ON a.id = l.account_id
    JOIN project p ON p.id = l.project_id
   WHERE a.code = ANY($1::text[])
     AND ($2::uuid[] IS NULL OR l.project_id = ANY($2::uuid[]))
     AND ($3::uuid IS NULL OR l.project_id = $3)
     AND NOT EXISTS (SELECT 1 FROM journal o WHERE o.id = j.reverses_journal_id AND o.source_type = j.source_type)
     AND NOT EXISTS (SELECT 1 FROM journal r WHERE r.reverses_journal_id = j.id AND r.source_type = j.source_type)
   GROUP BY j.id, a.code, p.id
  HAVING sum(l.debit) <> sum(l.credit)
   ORDER BY j.txn_date DESC, j.posted_at DESC`;

/** The drill-down behind a "Spend by category" slice: same rights and scope as the dashboard. */
export async function spendDetail(
  pool: pg.Pool,
  actor: Actor,
  categories: readonly CostCategory[],
  projectId?: string,
): Promise<SpendDetail> {
  authorize(actor, 'dashboard', 'view');
  if (projectId) assertId(projectId, 'Project');
  const cats = COST_CATEGORIES.filter((c) => categories.includes(c));
  const byCode = new Map(cats.map((c) => [CATEGORY_ACCOUNT[c], c]));
  const seeNames = can(actor, 'payroll', 'view');
  const rows = await withTenant(
    pool,
    ctx(actor),
    async (c) =>
      (
        await c.query<{
          date: string;
          narration: string;
          source_type: string;
          code: string;
          project_id: string;
          project_code: string;
          project_name: string;
          net: string;
        }>(SPEND_LINES, [[...byCode.keys()], projectScope(actor), projectId ?? null])
      ).rows,
  );
  const projects = new Map<string, SpendDetail['byProject'][number]>();
  const perCategory = new Map<CostCategory, Paise>(cats.map((c) => [c, 0]));
  const entries: SpendEntry[] = rows.map((r) => {
    const amount = fromDecimalString(r.net);
    const category = byCode.get(r.code) ?? 'misc';
    perCategory.set(category, (perCategory.get(category) ?? 0) + amount);
    const p = projects.get(r.project_id) ?? {
      projectId: r.project_id,
      code: r.project_code,
      name: r.project_name,
      amount: 0,
    };
    p.amount += amount;
    projects.set(r.project_id, p);
    const hidden = !seeNames && PAYROLL_SOURCES.includes(r.source_type);
    return {
      date: r.date,
      particulars: hidden ? 'Labour payment' : r.narration,
      category,
      projectId: r.project_id,
      projectCode: r.project_code,
      amount,
    };
  });
  return {
    categories: cats,
    total: entries.reduce((n, e) => n + e.amount, 0),
    byCategory: cats.map((c) => ({ category: c, amount: perCategory.get(c) ?? 0 })),
    byProject: [...projects.values()].sort((a, b) => b.amount - a.amount),
    entries: entries.slice(0, ENTRY_LIMIT),
    truncated: entries.length > ENTRY_LIMIT,
  };
}

/** Figures for one project's charts. Billing figures are present only with the invoices right. */
export interface ProjectCharts {
  spendByCategory: Record<CostCategory, Paise>;
  spent: Paise;
  costBudget: Paise;
  contractValue: Paise;
  billing: {
    /** Tax invoices raised, excluding GST (against the contract value). */
    invoicedTaxable: Paise;
    /** Tax invoices raised, including GST (what the client owes in total). */
    invoicedTotal: Paise;
    /** Client receipts, advances included. */
    received: Paise;
  } | null;
  /** The last six months, oldest first: sales (excl. GST, net of credit notes) and spend. */
  months: { month: string; invoiced: Paise; spent: Paise }[];
}

/** The last `n` calendar months as YYYY-MM, oldest first, ending with this month (IST). */
export function lastMonths(n: number, today: IsoDate = todayIn()): string[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - (n - 1 - i), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

export async function projectCharts(
  pool: pg.Pool,
  actor: Actor,
  projectId: string,
): Promise<ProjectCharts> {
  authorize(actor, 'dashboard', 'view');
  authorize(actor, 'projects', 'view', projectId);
  assertId(projectId, 'Project');
  const months = lastMonths(6);
  const billing = can(actor, 'invoices', 'view', projectId);
  return withTenant(pool, ctx(actor), async (c) => {
    const p = await c.query<{ contract_value: string; cost_budget: string }>(
      `SELECT contract_value::text, cost_budget::text FROM project
        WHERE id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
      [projectId, projectScope(actor)],
    );
    const project = p.rows[0];
    if (!project) throw new DomainError('NOT_FOUND', 'Project not found.');
    const spend = await spendByCategory(c, [projectId]);
    const b = billing
      ? (
          await c.query<{ taxable: string; total: string; received: string }>(
            `SELECT (SELECT coalesce(sum(taxable), 0) FROM invoice WHERE project_id = $1 AND status <> 'cancelled')::text AS taxable,
                    (SELECT coalesce(sum(total), 0) FROM invoice WHERE project_id = $1 AND status <> 'cancelled')::text AS total,
                    (SELECT coalesce(sum(amount), 0) FROM receipt WHERE project_id = $1 AND deleted_at IS NULL)::text AS received`,
            [projectId],
          )
        ).rows[0]
      : undefined;
    const m = await c.query<{ month: string; sales: string; cost: string }>(
      `SELECT to_char(j.txn_date, 'YYYY-MM') AS month,
              coalesce(sum(CASE WHEN a.code = '4000' THEN l.credit - l.debit END), 0)::text AS sales,
              coalesce(sum(CASE WHEN a.code = ANY($2::text[]) THEN l.debit - l.credit END), 0)::text AS cost
         FROM journal_line l JOIN journal j ON j.id = l.journal_id JOIN account a ON a.id = l.account_id
        WHERE l.project_id = $1 AND to_char(j.txn_date, 'YYYY-MM') >= $3
        GROUP BY 1`,
      [projectId, COST_ACCOUNTS, months[0]],
    );
    const spent = COST_CATEGORIES.reduce((n, cat) => n + spend[cat], 0);
    return {
      spendByCategory: spend,
      spent,
      costBudget: fromDecimalString(project.cost_budget),
      contractValue: fromDecimalString(project.contract_value),
      billing: b
        ? {
            invoicedTaxable: fromDecimalString(b.taxable),
            invoicedTotal: fromDecimalString(b.total),
            received: fromDecimalString(b.received),
          }
        : null,
      months: months.map((month) => {
        const r = m.rows.find((x) => x.month === month);
        return {
          month,
          invoiced: r ? fromDecimalString(r.sales) : 0,
          spent: r ? fromDecimalString(r.cost) : 0,
        };
      }),
    };
  });
}

function alertsFor(waiting: number | null, projects: DashboardProject[]): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];
  if (waiting)
    alerts.push({
      kind: 'approvals',
      tone: 'amber',
      text: `${waiting} ${waiting === 1 ? 'entry is' : 'entries are'} waiting for your approval.`,
      href: '/approvals',
    });
  for (const p of projects) {
    if (p.level === 'ok') continue;
    const pct = Math.floor(p.budgetUsedBp / 100);
    const over = p.level === 'red';
    alerts.push({
      kind: 'budget',
      tone: over ? 'red' : 'amber',
      text: over
        ? `${p.code} ${p.name} is over budget: ${pct}% of the cost budget spent.`
        : `${p.code} ${p.name} has used ${pct}% of its cost budget.`,
      href: `/projects/${p.projectId}`,
    });
  }
  return alerts;
}

/** Active projects in scope with invoiced, received and spent, newest code last. */
async function projectRows(c: pg.PoolClient, scope: Scope): Promise<DashboardProject[]> {
  const { rows } = await c.query<{
    id: string;
    code: string;
    name: string;
    client_name: string;
    cost_budget: string;
    invoiced: string;
    received: string;
    cost: string;
  }>(
    `SELECT p.id, p.code, p.name, k.name AS client_name, p.cost_budget::text,
            (SELECT coalesce(sum(i.total), 0) FROM invoice i
              WHERE i.project_id = p.id AND i.status <> 'cancelled')::text AS invoiced,
            (SELECT coalesce(sum(r.amount), 0) FROM receipt r
              WHERE r.project_id = p.id AND r.deleted_at IS NULL)::text AS received,
            (SELECT coalesce(sum(l.debit - l.credit), 0) FROM journal_line l JOIN account a ON a.id = l.account_id
              WHERE l.project_id = p.id AND a.code = ANY($2::text[]))::text AS cost
       FROM project p JOIN contact k ON k.id = p.client_id
      WHERE p.status = 'active' AND ($1::uuid[] IS NULL OR p.id = ANY($1::uuid[]))
      ORDER BY p.code`,
    [scope, COST_ACCOUNTS],
  );
  return rows.map((r) => {
    const income = fromDecimalString(r.received);
    const expense = fromDecimalString(r.cost);
    const costBudget = fromDecimalString(r.cost_budget);
    return {
      projectId: r.id,
      code: r.code,
      name: r.name,
      clientName: r.client_name,
      invoiceValue: fromDecimalString(r.invoiced),
      income,
      expense,
      net: income - expense,
      costBudget,
      budgetUsedBp: costBudget > 0 ? Math.round((expense / costBudget) * 10_000) : 0,
      level: budgetLevel(expense, costBudget),
    };
  });
}

/** Open invoice balances by ageing bucket (same rule as Outstanding → Receivables). */
async function receivables(
  c: pg.PoolClient,
  scope: Scope,
): Promise<{ total: Paise; buckets: Record<AgeingBucket, Paise> }> {
  const { rows } = await c.query<{ due_date: string; balance: string }>(
    `SELECT to_char(i.due_date, 'YYYY-MM-DD') AS due_date, b.balance::text
       FROM invoice i JOIN invoice_balance b ON b.invoice_id = i.id
      WHERE i.status <> 'cancelled' AND b.balance > 0
        AND ($1::uuid[] IS NULL OR i.project_id = ANY($1::uuid[]))`,
    [scope],
  );
  const today = todayIn();
  const buckets = Object.fromEntries(AGEING_BUCKETS.map((b) => [b, 0])) as Record<
    AgeingBucket,
    Paise
  >;
  let total = 0;
  for (const r of rows) {
    const balance = fromDecimalString(r.balance);
    buckets[ageingBucket(daysOverdue(r.due_date, today))] += balance;
    total += balance;
  }
  return { total, buckets };
}

/** Bills less approved payments (same rule as Outstanding → Payables). */
const PAYABLES = `SELECT coalesce(sum(x.balance), 0)::text AS n
   FROM bill b JOIN bill_balance x ON x.bill_id = b.id
  WHERE b.deleted_at IS NULL AND x.balance > 0
    AND ($1::uuid[] IS NULL OR b.project_id = ANY($1::uuid[]))`;

async function sumOf(c: pg.PoolClient, sql: string, scope: Scope): Promise<Paise> {
  const { rows } = await c.query<{ n: string }>(sql, [scope]);
  return fromDecimalString(rows[0]?.n ?? '0');
}

async function cashAndBank(c: pg.PoolClient): Promise<Paise> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n
       FROM journal_line l JOIN account a ON a.id = l.account_id WHERE a.code = ANY($1::text[])`,
    [MONEY_ACCOUNTS],
  );
  return fromDecimalString(rows[0]?.n ?? '0');
}

/** Client receipts dated in the current financial year. */
async function collectedThisYear(c: pg.PoolClient, scope: Scope): Promise<Paise> {
  const company = await companyRow(c);
  const from = financialYearStart(todayIn(), company.fy_start_month);
  const { rows } = await c.query<{ n: string }>(
    `SELECT coalesce(sum(r.amount), 0)::text AS n FROM receipt r
      WHERE r.deleted_at IS NULL AND r.receipt_date >= $2::date
        AND ($1::uuid[] IS NULL OR r.project_id = ANY($1::uuid[]))`,
    [scope, from],
  );
  return fromDecimalString(rows[0]?.n ?? '0');
}

async function spendByCategory(
  c: pg.PoolClient,
  scope: Scope,
): Promise<Record<CostCategory, Paise>> {
  const { rows } = await c.query<{ code: string; net: string }>(
    `SELECT a.code, sum(l.debit - l.credit)::text AS net
       FROM journal_line l JOIN account a ON a.id = l.account_id
      WHERE a.code = ANY($1::text[]) AND l.project_id IS NOT NULL
        AND ($2::uuid[] IS NULL OR l.project_id = ANY($2::uuid[]))
      GROUP BY a.code`,
    [COST_ACCOUNTS, scope],
  );
  const out = Object.fromEntries(COST_CATEGORIES.map((cat) => [cat, 0])) as Record<
    CostCategory,
    Paise
  >;
  for (const cat of COST_CATEGORIES) {
    const row = rows.find((r) => r.code === CATEGORY_ACCOUNT[cat]);
    if (row) out[cat] = fromDecimalString(row.net);
  }
  return out;
}
