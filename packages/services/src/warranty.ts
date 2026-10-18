import {
  DomainError,
  WARRANTY_MONTHS,
  assertId,
  authorize,
  can,
  fromDecimalString,
  projectScope,
  todayIn,
  warrantyStatus,
  type Actor,
  type IsoDate,
  type Paise,
  type WarrantyStatus,
} from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { isoDate, parse, tenantOf as ctx } from './validation.js';

const handoverSchema = z.object({
  handoverDate: isoDate,
  warrantyMonths: z
    .number()
    .refine(
      (n) => (WARRANTY_MONTHS as readonly number[]).includes(n),
      'Pick 6 months, 1, 2 or 5 years.',
    ),
  amcUntil: isoDate.nullable().optional(),
});
export type HandoverInput = z.input<typeof handoverSchema>;

export interface WarrantyRow {
  projectId: string;
  projectCode: string;
  projectName: string;
  clientName: string;
  startDate: IsoDate;
  handoverDate: IsoDate | null;
  warrantyMonths: number;
  warrantyEnd: IsoDate | null;
  daysLeft: number | null;
  status: WarrantyStatus;
  amcUntil: IsoDate | null;
  openTickets: number;
  totalTickets: number;
  /** Approved costs of service visits on the project's tickets. */
  repairCost: Paise;
}

interface Row {
  id: string;
  code: string;
  name: string;
  client_name: string;
  start_date: string;
  handover_date: string | null;
  warranty_months: number;
  amc_until: string | null;
  open_tickets: number;
  total_tickets: number;
  repair_cost: string;
}

/** Warranty register (Req §4.20): one warranty per project, from handover. */
export class WarrantyService {
  constructor(private readonly pool: pg.Pool) {}

  async register(actor: Actor): Promise<WarrantyRow[]> {
    authorize(actor, 'warranty', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Row>(
        `SELECT p.id, p.code, p.name, ct.name AS client_name, to_char(p.start_date, 'YYYY-MM-DD') AS start_date,
                to_char(p.handover_date, 'YYYY-MM-DD') AS handover_date, p.warranty_months,
                to_char(p.amc_until, 'YYYY-MM-DD') AS amc_until,
                (SELECT count(*) FROM ticket t WHERE t.project_id = p.id AND t.status NOT IN ('resolved', 'closed'))::int AS open_tickets,
                (SELECT count(*) FROM ticket t WHERE t.project_id = p.id)::int AS total_tickets,
                coalesce((SELECT sum(e.amount) FROM expense e
                           WHERE e.project_id = p.id AND e.ticket_id IS NOT NULL AND e.status = 'approved'
                             AND e.deleted_at IS NULL), 0)::text AS repair_cost
           FROM project p JOIN contact ct ON ct.id = p.client_id
          WHERE p.status <> 'cancelled' AND ($1::uuid[] IS NULL OR p.id = ANY($1::uuid[]))
          ORDER BY p.handover_date IS NULL, p.handover_date DESC, p.code`,
        [projectScope(actor)],
      );
      const today = todayIn();
      return rows
        .filter((r) => can(actor, 'warranty', 'view', r.id))
        .map((r) => {
          const w = warrantyStatus(r.handover_date, r.warranty_months, today);
          return {
            projectId: r.id,
            projectCode: r.code,
            projectName: r.name,
            clientName: r.client_name,
            startDate: r.start_date,
            handoverDate: r.handover_date,
            warrantyMonths: r.warranty_months,
            warrantyEnd: w.end,
            daysLeft: w.daysLeft,
            status: w.status,
            amcUntil: r.amc_until,
            openTickets: r.open_tickets,
            totalTickets: r.total_tickets,
            repairCost: fromDecimalString(r.repair_cost),
          };
        });
    });
  }

  /** FR-20.2/20.3: handover date (not future, not before start), period and AMC; marks it Completed. */
  async recordHandover(actor: Actor, projectId: string, input: HandoverInput): Promise<void> {
    assertId(projectId, 'Project');
    const data = parse(handoverSchema, input);
    authorize(actor, 'warranty', 'edit', projectId);
    if (data.handoverDate > todayIn())
      throw new DomainError('VALIDATION', 'The handover cannot be in the future.', 'handoverDate');
    if (data.amcUntil && data.amcUntil < data.handoverDate)
      throw new DomainError('VALIDATION', 'The AMC must end after the handover.', 'amcUntil');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{ start: string; status: string; handover: string | null }>(
        `SELECT to_char(start_date, 'YYYY-MM-DD') AS start, status, to_char(handover_date, 'YYYY-MM-DD') AS handover
           FROM project WHERE id = $1 FOR UPDATE`,
        [projectId],
      );
      const p = rows[0];
      if (!p) throw new DomainError('NOT_FOUND', 'Project not found.');
      if (p.status === 'cancelled') throw new DomainError('CONFLICT', 'The project is cancelled.');
      if (data.handoverDate < p.start)
        throw new DomainError(
          'VALIDATION',
          'The handover cannot be before the project start.',
          'handoverDate',
        );
      await c.query(
        `UPDATE project SET handover_date = $2, warranty_months = $3, amc_until = $4, status = 'completed',
                updated_by = app_user_id() WHERE id = $1`,
        [projectId, data.handoverDate, data.warrantyMonths, data.amcUntil ?? null],
      );
      await writeAudit(c, {
        action: 'handover',
        entity: 'project',
        entityId: projectId,
        before: { handoverDate: p.handover, status: p.status },
        after: data,
      });
    });
  }
}
