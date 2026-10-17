import { authorize, can, fromDecimalString, projectScope, type Actor, type Paise } from '@csd/core';
import { withTenant } from '@csd/db';
import type pg from 'pg';
import { tenantOf as ctx } from './validation.js';

export interface SupportDashboard {
  /** Hours, over tickets with a response / resolution; null when there are none. */
  avgFirstResponseHours: number | null;
  avgResolutionHours: number | null;
  /** 0–100, over tickets whose clock has finished or run out. */
  responseSlaMetPct: number | null;
  resolutionSlaMetPct: number | null;
  avgRating: number | null;
  serviceCost: { approved: Paise; pending: Paise };
  byType: { key: string; count: number }[];
  byStatus: { key: string; count: number }[];
  byProject: { key: string; count: number }[];
  workload: {
    name: string;
    open: number;
    resolved: number;
    breached: number;
    avgRating: number | null;
  }[];
}

const metrics = (m: Record<string, string | null>) => ({
  avgFirstResponseHours: round1(m['resp'] ?? null),
  avgResolutionHours: round1(m['res'] ?? null),
  responseSlaMetPct: round1(m['resp_met'] ?? null),
  resolutionSlaMetPct: round1(m['res_met'] ?? null),
  avgRating: round1(m['rating'] ?? null),
});

const costsFor = (actor: Actor, r: { approved: string; pending: string } | undefined) =>
  can(actor, 'expenses', 'view')
    ? {
        approved: fromDecimalString(r?.approved ?? '0'),
        pending: fromDecimalString(r?.pending ?? '0'),
      }
    : { approved: 0, pending: 0 };

const round1 = (v: string | null) => (v === null ? null : Math.round(Number(v) * 10) / 10);

/** Support → Dashboard (FR-19.12), within the actor's project scope. */
export class SupportDashboardService {
  constructor(private readonly pool: pg.Pool) {}

  async get(actor: Actor): Promise<SupportDashboard> {
    authorize(actor, 'tickets', 'view');
    const scope = [projectScope(actor)];
    return withTenant(this.pool, ctx(actor), async (c) => {
      const scoped = `($1::uuid[] IS NULL OR t.project_id = ANY($1::uuid[]))`;
      const { rows } = await c.query<Record<string, string | null>>(
        `SELECT avg(extract(epoch FROM t.first_response_at - t.created_at) / 3600)::text AS resp,
                avg(extract(epoch FROM t.resolved_at - t.created_at) / 3600)::text AS res,
                (100.0 * count(*) FILTER (WHERE t.first_response_at <= t.resp_due)
                   / nullif(count(*) FILTER (WHERE t.first_response_at IS NOT NULL OR t.resp_due < now()), 0))::text AS resp_met,
                (100.0 * count(*) FILTER (WHERE t.resolved_at <= t.resolve_due)
                   / nullif(count(*) FILTER (WHERE t.resolved_at IS NOT NULL OR t.resolve_due < now()), 0))::text AS res_met,
                avg(t.rating)::text AS rating
           FROM ticket t WHERE ${scoped}`,
        scope,
      );
      const m = rows[0] ?? {};
      const cost = await c.query<{ approved: string; pending: string }>(
        `SELECT coalesce(sum(e.amount) FILTER (WHERE e.status = 'approved'), 0)::text AS approved,
                coalesce(sum(e.amount) FILTER (WHERE e.status = 'pending'), 0)::text AS pending
           FROM expense e WHERE e.ticket_id IS NOT NULL AND e.deleted_at IS NULL
            AND ($1::uuid[] IS NULL OR e.project_id = ANY($1::uuid[]))`,
        scope,
      );
      const group = async (expr: string, join = '') =>
        (
          await c.query<{ key: string; count: number }>(
            `SELECT ${expr} AS key, count(*)::int AS count FROM ticket t ${join}
              WHERE ${scoped} GROUP BY 1 ORDER BY 2 DESC, 1`,
            scope,
          )
        ).rows;
      const workload = await c.query<{
        name: string;
        open: number;
        resolved: number;
        breached: number;
        rating: string | null;
      }>(
        `SELECT u.name, count(*) FILTER (WHERE t.status NOT IN ('resolved', 'closed'))::int AS open,
                count(*) FILTER (WHERE t.status IN ('resolved', 'closed'))::int AS resolved,
                count(*) FILTER (WHERE coalesce(t.resolved_at, now()) > t.resolve_due
                                    OR coalesce(t.first_response_at, t.resolved_at, now()) > t.resp_due)::int AS breached,
                avg(t.rating)::text AS rating
           FROM ticket t JOIN app_user u ON u.id = t.assignee_id
          WHERE ${scoped} GROUP BY u.id, u.name ORDER BY open DESC, u.name`,
        scope,
      );
      return {
        ...metrics(m),
        // Costs follow the expenses right, as on the ticket's billing card.
        serviceCost: costsFor(actor, cost.rows[0]),
        byType: await group('t.type'),
        byStatus: await group('t.status'),
        byProject: await group('p.code', 'JOIN project p ON p.id = t.project_id'),
        workload: workload.rows.map((w) => ({
          name: w.name,
          open: w.open,
          resolved: w.resolved,
          breached: w.breached,
          avgRating: round1(w.rating),
        })),
      };
    });
  }
}
