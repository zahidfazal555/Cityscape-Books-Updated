import { CATEGORY_ACCOUNT } from '@csd/core';
import type pg from 'pg';

/** Budget alerts (README "Budget alerts"): amber from 85% of the cost budget, red above 100%. */
export const BUDGET_AMBER_BP = 8_500;
export const BUDGET_RED_BP = 10_000;

/** Project cost accounts 5000–5080. */
export const COST_ACCOUNTS = Object.values(CATEGORY_ACCOUNT);

/**
 * In-app budget alerts to the Owner (Tech Spec §9 "Budget alert"): once when a project first
 * reaches 85% of its cost budget and once when it goes over 100%. The key makes each one a
 * single notification however often this runs.
 */
export async function notifyBudget(c: pg.PoolClient): Promise<void> {
  await c.query(
    `WITH spent AS (
       SELECT p.id, p.code, p.name, p.cost_budget,
              coalesce((SELECT sum(l.debit - l.credit) FROM journal_line l JOIN account a ON a.id = l.account_id
                         WHERE l.project_id = p.id AND a.code = ANY($1::text[])), 0) AS cost
         FROM project p WHERE p.status = 'active' AND p.cost_budget > 0),
     level AS (
       SELECT *, CASE WHEN cost > cost_budget THEN 'over' WHEN cost >= cost_budget * 0.85 THEN '85' END AS lvl
         FROM spent)
     INSERT INTO notification (company_id, user_id, key, type, title, body, link)
     SELECT app_company_id(), o.id, 'budget:' || l.id || ':' || l.lvl, 'budget',
            l.code || CASE WHEN l.lvl = 'over' THEN ' is over budget' ELSE ' has used 85% of its budget' END,
            l.name || ': ' || floor(l.cost / l.cost_budget * 100) || '% of the cost budget spent.',
            '/projects/' || l.id
       FROM level l CROSS JOIN LATERAL (SELECT id FROM app_user WHERE role = 'owner' LIMIT 1) o
      WHERE l.lvl IS NOT NULL
     ON CONFLICT (user_id, key) DO NOTHING`,
    [COST_ACCOUNTS],
  );
}
