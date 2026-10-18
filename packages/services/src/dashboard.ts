import {
  AGEING_BUCKETS,
  CATEGORY_ACCOUNT,
  COST_CATEGORIES,
  ageingBucket,
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
  type Paise,
} from '@csd/core';
import { withTenant } from '@csd/db';
import type pg from 'pg';
import { ApprovalsService } from './approvals.js';
import { BUDGET_AMBER_BP, BUDGET_RED_BP, COST_ACCOUNTS, notifyBudget } from './budget-alerts.js';
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
  /** Share of the cost budget used, in basis points (0 without a budget). */
  budgetUsedBp: number;
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

  async summary(actor: Actor): Promise<Dashboard> {
    authorize(actor, 'dashboard', 'view');
    const waiting = canApprove(actor) ? await this.approvals.count(actor) : null;
    const data = await withTenant(this.pool, ctx(actor), async (c) => {
      const scope = projectScope(actor);
      if (canApprove(actor)) await notifyBudget(c);
      return {
        projects: await projectRows(c, scope),
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
    if (p.costBudget <= 0 || p.budgetUsedBp < BUDGET_AMBER_BP) continue;
    const pct = Math.floor(p.budgetUsedBp / 100);
    const over = p.budgetUsedBp > BUDGET_RED_BP;
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
