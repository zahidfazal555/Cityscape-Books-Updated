import {
  CATEGORY_ACCOUNT,
  COST_CATEGORIES,
  DomainError,
  authorize,
  can,
  fromDecimalString,
  projectScope,
  stripPnl,
  type Actor,
  type CostCategory,
  type Paise,
} from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { tenantOf as ctx } from './validation.js';

export interface ProjectFigures {
  projectId: string;
  code: string;
  name: string;
  clientName: string;
  contractValue: Paise;
  costBudget: Paise;
  /** Sales (account 4000) net of credit notes, excluding GST. */
  revenue: Paise;
  /** Project cost accounts (5000–5080), net of reversals. */
  cost: Paise;
  /** Share of the cost budget used, in basis points. */
  budgetUsedBp: number;
  /** Removed for users without `pnl` (Tech Spec §5). */
  profit?: Paise;
  margin?: number | null;
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  debit: Paise;
  credit: Paise;
}

export type ReportName =
  'income-expense' | 'pnl' | 'category' | 'trial-balance' | 'gstr1-csv' | 'bank-register';

/**
 * Reports (Req §4.16). SPEC-FIXES A3: project P&L is the sum of the journal by project over
 * income and project-cost accounts; pending and rejected entries never reach it.
 */
export class ReportsService {
  constructor(private readonly pool: pg.Pool) {}

  /** Income & expenses per project (profit fields stripped without `pnl`). */
  async projectIncomeExpense(actor: Actor): Promise<ProjectFigures[]> {
    authorize(actor, 'reports', 'view');
    return stripPnl(actor, await this.figures(actor));
  }

  /** FR-16.1: project P&L, `pnl` only, sorted by margin (highest first). */
  async projectPnl(actor: Actor): Promise<ProjectFigures[]> {
    authorize(actor, 'reports', 'view');
    authorize(actor, 'pnl', 'view');
    const rows = await this.figures(actor);
    return rows.sort((a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity));
  }

  /** Spend by category: a pivot of the nine categories against projects. */
  async categoryPivot(actor: Actor): Promise<{
    projects: {
      projectId: string;
      code: string;
      byCategory: Record<CostCategory, Paise>;
      total: Paise;
    }[];
    totals: Record<CostCategory, Paise>;
  }> {
    authorize(actor, 'reports', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{
        project_id: string;
        code: string;
        account: string;
        net: string;
      }>(
        `SELECT p.id AS project_id, p.code, a.code AS account, sum(l.debit - l.credit)::text AS net
           FROM journal_line l JOIN account a ON a.id = l.account_id JOIN project p ON p.id = l.project_id
          WHERE a.code = ANY($1::text[]) AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))
          GROUP BY p.id, p.code, a.code`,
        [Object.values(CATEGORY_ACCOUNT), projectScope(actor)],
      );
      const byAccount = Object.fromEntries(
        COST_CATEGORIES.map((cat) => [CATEGORY_ACCOUNT[cat], cat]),
      ) as Record<string, CostCategory>;
      const zero = () =>
        Object.fromEntries(COST_CATEGORIES.map((cat) => [cat, 0])) as Record<CostCategory, Paise>;
      const totals = zero();
      const by = new Map<
        string,
        { projectId: string; code: string; byCategory: Record<CostCategory, Paise>; total: Paise }
      >();
      for (const r of rows) {
        const cat = byAccount[r.account];
        if (!cat) continue;
        const cur = by.get(r.project_id) ?? {
          projectId: r.project_id,
          code: r.code,
          byCategory: zero(),
          total: 0,
        };
        const amt = fromDecimalString(r.net);
        cur.byCategory[cat] += amt;
        cur.total += amt;
        totals[cat] += amt;
        by.set(r.project_id, cur);
      }
      return { projects: [...by.values()].sort((a, b) => a.code.localeCompare(b.code)), totals };
    });
  }

  /** FR-16.3: every account's debits and credits, with the balance check (Owner or `pnl`). */
  async trialBalance(
    actor: Actor,
  ): Promise<{ rows: TrialBalanceRow[]; debit: Paise; credit: Paise; balanced: boolean }> {
    authorize(actor, 'reports', 'view');
    if (actor.role !== 'owner' && !can(actor, 'pnl', 'view'))
      throw new DomainError('FORBIDDEN', 'The trial balance needs the profit right.');
    if (projectScope(actor) !== null)
      throw new DomainError('FORBIDDEN', 'The trial balance needs access to all projects.');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{
        code: string;
        name: string;
        type: string;
        debit: string;
        credit: string;
      }>(
        `SELECT a.code, a.name, a.type, coalesce(sum(l.debit), 0)::text AS debit, coalesce(sum(l.credit), 0)::text AS credit
           FROM account a LEFT JOIN journal_line l ON l.account_id = a.id
          GROUP BY a.code, a.name, a.type HAVING coalesce(sum(l.debit), 0) + coalesce(sum(l.credit), 0) > 0
          ORDER BY a.code`,
      );
      const list = rows.map((r) => ({
        code: r.code,
        name: r.name,
        type: r.type,
        debit: fromDecimalString(r.debit),
        credit: fromDecimalString(r.credit),
      }));
      const debit = list.reduce((s, r) => s + r.debit, 0);
      const credit = list.reduce((s, r) => s + r.credit, 0);
      return { rows: list, debit, credit, balanced: debit === credit };
    });
  }

  /** H4: a CSV export of any report writes an audit row (the report's own rights apply first). */
  async recordExport(actor: Actor, report: ReportName, rows: number): Promise<void> {
    await withTenant(this.pool, ctx(actor), (c) =>
      writeAudit(c, {
        action: 'export',
        entity: 'report',
        entityId: null,
        after: { format: 'csv', report, rows },
      }),
    );
  }

  private async figures(actor: Actor): Promise<ProjectFigures[]> {
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{
        id: string;
        code: string;
        name: string;
        client_name: string;
        contract_value: string;
        cost_budget: string;
        revenue: string;
        cost: string;
      }>(
        `SELECT p.id, p.code, p.name, k.name AS client_name, p.contract_value::text, p.cost_budget::text,
                coalesce(sum(l.credit - l.debit) FILTER (WHERE a.code = '4000'), 0)::text AS revenue,
                coalesce(sum(l.debit - l.credit) FILTER (WHERE a.code = ANY($2::text[])), 0)::text AS cost
           FROM project p
           JOIN contact k ON k.id = p.client_id
           LEFT JOIN journal_line l ON l.project_id = p.id
           LEFT JOIN account a ON a.id = l.account_id
          WHERE ($1::uuid[] IS NULL OR p.id = ANY($1::uuid[]))
          GROUP BY p.id, p.code, p.name, k.name ORDER BY p.code`,
        [projectScope(actor), Object.values(CATEGORY_ACCOUNT)],
      );
      return rows.map((r) => {
        const revenue = fromDecimalString(r.revenue);
        const cost = fromDecimalString(r.cost);
        const costBudget = fromDecimalString(r.cost_budget);
        const profit = revenue - cost;
        return {
          projectId: r.id,
          code: r.code,
          name: r.name,
          clientName: r.client_name,
          contractValue: fromDecimalString(r.contract_value),
          costBudget,
          revenue,
          cost,
          budgetUsedBp: costBudget > 0 ? Math.round((cost / costBudget) * 10_000) : 0,
          profit,
          margin: revenue > 0 ? profit / revenue : null,
        };
      });
    });
  }
}
