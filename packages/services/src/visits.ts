import { randomUUID } from 'node:crypto';
import {
  ACCOUNT_FOR_MODE,
  COST_CATEGORIES,
  DomainError,
  assertId,
  assertNotLocked,
  authorize,
  can,
  fromDecimalString,
  projectScope,
  todayIn,
  toDecimalString,
  type Actor,
  type CostCategory,
  type IsoDate,
  type Paise,
} from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { claimAttachment } from './attachments.js';
import { assertLiveProject } from './purchase-orders.js';
import { loadTicket, systemEvent } from './tickets.js';
import { companyRow, isoDate, parse, tenantOf as ctx } from './validation.js';

export const VISIT_SLOTS = ['morning', 'afternoon', 'evening'] as const;
export type VisitSlot = (typeof VISIT_SLOTS)[number];
export type VisitStatus = 'scheduled' | 'completed' | 'cancelled';

const scheduleSchema = z.object({
  visitDate: isoDate,
  slot: z.enum(VISIT_SLOTS),
  engineerId: z.string().uuid('Choose the site engineer.'),
  instructions: z.string().trim().max(2000).nullable().optional(),
});
const photos = z.array(z.string().uuid()).max(10, 'At most 10 photos.');
const completeSchema = z
  .object({
    beforeIds: photos.min(1, 'Add at least one before photo.'),
    afterIds: photos.min(1, 'Add at least one after photo.'),
    workDone: z.string().trim().min(1, 'Describe what was done.').max(4000),
    cost: z.number().int('Amount must be in paise.').positive().nullable().optional(),
    category: z.enum(COST_CATEGORIES).default('site_visit'),
    mode: z.enum(['cash', 'upi', 'bank']).default('cash'),
    billPhotoId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => !v.cost || !!v.billPhotoId, {
    message: 'Add a photo of the bill for the cost.',
    path: ['billPhotoId'],
  })
  .refine(
    (v) =>
      new Set([...v.beforeIds, ...v.afterIds, v.billPhotoId ?? '']).size ===
      v.beforeIds.length + v.afterIds.length + 1,
    {
      message: 'Use each photo once.',
      path: ['afterIds'],
    },
  );

export type ScheduleInput = z.input<typeof scheduleSchema>;
export type CompleteInput = z.input<typeof completeSchema>;

export interface SiteVisit {
  id: string;
  ticketId: string;
  ticketNumber: string;
  subject: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  siteAddress: string | null;
  clientName: string;
  callerName: string | null;
  callerPhone: string | null;
  coverage: string;
  visitDate: IsoDate;
  slot: VisitSlot;
  engineerId: string;
  engineerName: string;
  instructions: string | null;
  status: VisitStatus;
  workDone: string | null;
  cost: Paise | null;
  expenseId: string | null;
  photos: { id: string; phase: 'before' | 'after' }[];
}

interface Row {
  id: string;
  ticket_id: string;
  ticket_number: string;
  subject: string;
  project_id: string;
  project_code: string;
  project_name: string;
  site_address: string | null;
  client_name: string;
  caller_name: string | null;
  caller_phone: string | null;
  coverage: string;
  visit_date: string;
  slot: VisitSlot;
  engineer_id: string;
  engineer_name: string;
  instructions: string | null;
  status: VisitStatus;
  work_done: string | null;
  cost: string | null;
  expense_id: string | null;
  photos: { id: string; phase: 'before' | 'after' }[];
}

const SELECT = `
  SELECT v.id, v.ticket_id, t.number AS ticket_number, t.subject, t.project_id, p.code AS project_code,
         p.name AS project_name, p.site_address, c.name AS client_name, t.caller_name, t.caller_phone, t.coverage,
         to_char(v.visit_date, 'YYYY-MM-DD') AS visit_date, v.slot, v.engineer_id, u.name AS engineer_name,
         v.instructions, v.status, v.work_done, v.cost::text, v.expense_id,
         coalesce((SELECT json_agg(json_build_object('id', ph.attachment_id, 'phase', ph.phase) ORDER BY ph.created_at)
                     FROM visit_photo ph WHERE ph.visit_id = v.id), '[]'::json) AS photos
    FROM site_visit v
    JOIN ticket t ON t.id = v.ticket_id
    JOIN project p ON p.id = t.project_id
    JOIN contact c ON c.id = p.client_id
    JOIN app_user u ON u.id = v.engineer_id`;

const toVisit = (r: Row): SiteVisit => ({
  id: r.id,
  ticketId: r.ticket_id,
  ticketNumber: r.ticket_number,
  subject: r.subject,
  projectId: r.project_id,
  projectCode: r.project_code,
  projectName: r.project_name,
  siteAddress: r.site_address,
  clientName: r.client_name,
  callerName: r.caller_name,
  callerPhone: r.caller_phone,
  coverage: r.coverage,
  visitDate: r.visit_date,
  slot: r.slot,
  engineerId: r.engineer_id,
  engineerName: r.engineer_name,
  instructions: r.instructions,
  status: r.status,
  workDone: r.work_done,
  cost: r.cost === null ? null : fromDecimalString(r.cost),
  expenseId: r.expense_id,
  photos: r.photos,
});

const SLOT_LABEL: Record<VisitSlot, string> = {
  morning: 'Morning 9–12',
  afternoon: 'Afternoon 12–4',
  evening: 'Evening 4–7',
};

/** A site engineer sees only their own visits, whatever their project scope (Tech Spec §14). */
function canSee(actor: Actor, r: Row): boolean {
  return r.engineer_id === actor.userId || can(actor, 'tickets', 'view', r.project_id);
}

/** Site visits (FR-19.9, FR-23.4/23.5). */
export class VisitsService {
  constructor(private readonly pool: pg.Pool) {}

  /** A ticket's visits, or every visit (Support → Site visits tab), scheduled first. */
  async list(actor: Actor, ticketId?: string): Promise<SiteVisit[]> {
    authorize(actor, 'tickets', 'view');
    if (ticketId) assertId(ticketId, 'Ticket');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Row>(
        `${SELECT} WHERE ($1::uuid IS NULL OR v.ticket_id = $1)
           AND ($2::uuid[] IS NULL OR t.project_id = ANY($2::uuid[]) OR v.engineer_id = app_user_id())
         ORDER BY v.status = 'scheduled' DESC, v.visit_date DESC, v.created_at DESC LIMIT 500`,
        [ticketId ?? null, projectScope(actor)],
      );
      return rows.filter((r) => canSee(actor, r)).map(toVisit);
    });
  }

  /**
   * The engineer's own visits (mobile home): scheduled first, oldest date first. No rights module:
   * a site engineer reads only `engineer_id = me` (Technical Spec §14), enforced in the query.
   */
  async mine(actor: Actor): Promise<SiteVisit[]> {
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Row>(
        `${SELECT} WHERE v.engineer_id = app_user_id()
         ORDER BY v.status = 'scheduled' DESC, v.visit_date, v.created_at LIMIT 200`,
      );
      return rows.map(toVisit);
    });
  }

  async get(actor: Actor, id: string): Promise<SiteVisit> {
    return withTenant(this.pool, ctx(actor), (c) => visitById(c, actor, id));
  }

  /** "Schedule site visit": the ticket becomes Visit scheduled. */
  async schedule(actor: Actor, ticketId: string, input: ScheduleInput): Promise<{ id: string }> {
    const data = parse(scheduleSchema, input);
    authorize(actor, 'tickets', 'edit');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const t = await loadTicket(c, actor, ticketId, true);
      authorize(actor, 'tickets', 'edit', t.projectId);
      if (t.status === 'resolved' || t.status === 'closed')
        throw new DomainError('CONFLICT', 'Reopen the ticket before scheduling a visit.');
      if (data.visitDate < todayIn())
        throw new DomainError('VALIDATION', 'Pick today or a later date.', 'visitDate');
      const eng = await c.query<{ name: string }>(
        `SELECT name FROM app_user WHERE id = $1 AND is_active AND role = 'site'`,
        [data.engineerId],
      );
      const engineer = eng.rows[0];
      if (!engineer)
        throw new DomainError('VALIDATION', 'Choose an active site engineer.', 'engineerId');
      const id = randomUUID();
      await c.query(
        `INSERT INTO site_visit (id, company_id, ticket_id, visit_date, slot, engineer_id, instructions, created_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, app_user_id())`,
        [id, ticketId, data.visitDate, data.slot, data.engineerId, data.instructions ?? null],
      );
      await c.query(
        `UPDATE ticket SET status = 'visit_scheduled', updated_by = app_user_id() WHERE id = $1`,
        [ticketId],
      );
      await systemEvent(
        c,
        ticketId,
        `Visit scheduled ${data.visitDate} · ${SLOT_LABEL[data.slot]} · ${engineer.name}`,
      );
      await writeAudit(c, { action: 'create', entity: 'site_visit', entityId: id, after: data });
      return { id };
    });
  }

  /** Cancels a scheduled visit; the ticket goes back to In progress if no other is scheduled. */
  async cancel(actor: Actor, id: string): Promise<void> {
    authorize(actor, 'tickets', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const v = await lockScheduled(c, actor, id);
      authorize(actor, 'tickets', 'edit', v.projectId);
      await c.query(`UPDATE site_visit SET status = 'cancelled' WHERE id = $1`, [id]);
      await afterVisit(c, v.ticketId);
      await systemEvent(c, v.ticketId, `Visit on ${v.visitDate} cancelled`);
      await writeAudit(c, { action: 'cancel', entity: 'site_visit', entityId: id });
    });
  }

  /**
   * FR-23.5: the engineer (or a ticket handler) completes the visit with before and after photos and
   * the work done. A cost becomes a Pending expense on the ticket's project, in the Owner's queue.
   */
  async complete(
    actor: Actor,
    id: string,
    input: CompleteInput,
  ): Promise<{ expenseId: string | null }> {
    const data = parse(completeSchema, input);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const v = await lockScheduled(c, actor, id);
      if (v.engineerId !== actor.userId) authorize(actor, 'tickets', 'edit', v.projectId);
      for (const [ids, phase] of [
        [data.beforeIds, 'before'],
        [data.afterIds, 'after'],
      ] as const)
        for (const a of ids) await addPhoto(c, actor, id, a, phase);
      const expenseId = data.cost
        ? await visitExpense(c, actor, v, { ...data, cost: data.cost })
        : null;
      await c.query(
        `UPDATE site_visit SET status = 'completed', work_done = $2, cost = $3, expense_id = $4,
                completed_at = now(), completed_by = app_user_id() WHERE id = $1`,
        [id, data.workDone, data.cost ? toDecimalString(data.cost) : null, expenseId],
      );
      // BUG-157: completing a visit always moves the ticket to In progress (README §18).
      await c.query(
        `UPDATE ticket SET status = 'in_progress', updated_by = app_user_id()
          WHERE id = $1 AND status NOT IN ('resolved', 'closed')
            AND NOT EXISTS (SELECT 1 FROM site_visit WHERE ticket_id = $1 AND status = 'scheduled')`,
        [v.ticketId],
      );
      await systemEvent(c, v.ticketId, `Visit completed by ${v.engineerName}`);
      await c.query(
        `INSERT INTO ticket_event (company_id, ticket_id, kind, body, author_id)
         VALUES (app_company_id(), $1, 'note', $2, app_user_id())`,
        [v.ticketId, `Work done: ${data.workDone}`],
      );
      await writeAudit(c, {
        action: 'complete',
        entity: 'site_visit',
        entityId: id,
        after: { ...data, expenseId },
      });
      return { expenseId };
    });
  }
}

async function visitById(
  c: pg.PoolClient,
  actor: Actor,
  id: string,
  forUpdate = false,
): Promise<SiteVisit & { projectId: string }> {
  assertId(id, 'Visit');
  const { rows } = await c.query<Row>(
    `${SELECT} WHERE v.id = $1${forUpdate ? ' FOR UPDATE OF v' : ''}`,
    [id],
  );
  const r = rows[0];
  if (!r || !canSee(actor, r)) throw new DomainError('NOT_FOUND', 'Visit not found.');
  return { ...toVisit(r), projectId: r.project_id };
}

async function lockScheduled(c: pg.PoolClient, actor: Actor, id: string) {
  // Ticket first, then the visit: the same order as scheduling, so no deadlock.
  await c.query(
    `SELECT 1 FROM ticket WHERE id = (SELECT ticket_id FROM site_visit WHERE id = $1) FOR UPDATE`,
    [id],
  );
  const v = await visitById(c, actor, id, true);
  if (v.status !== 'scheduled')
    throw new DomainError('CONFLICT', `This visit is already ${v.status}.`);
  return v;
}

/** The ticket leaves "Visit scheduled" once no visit is still scheduled. */
async function afterVisit(c: pg.PoolClient, ticketId: string): Promise<void> {
  await c.query(
    `UPDATE ticket SET status = 'in_progress', updated_by = app_user_id()
      WHERE id = $1 AND status = 'visit_scheduled'
        AND NOT EXISTS (SELECT 1 FROM site_visit WHERE ticket_id = $1 AND status = 'scheduled')`,
    [ticketId],
  );
}

async function addPhoto(
  c: pg.PoolClient,
  actor: Actor,
  visitId: string,
  attachmentId: string,
  phase: 'before' | 'after',
): Promise<void> {
  await claimAttachment(c, actor, attachmentId, visitId);
  const { rows } = await c.query<{ content_type: string }>(
    `SELECT content_type FROM attachment WHERE id = $1`,
    [attachmentId],
  );
  if (rows[0]?.content_type === 'application/pdf')
    throw new DomainError('VALIDATION', 'Site photos must be photos, not PDFs.', `${phase}Ids`);
  await c.query(
    `INSERT INTO visit_photo (company_id, visit_id, attachment_id, phase) VALUES (app_company_id(), $1, $2, $3)`,
    [visitId, attachmentId, phase],
  );
}

/** A Pending expense (source 'visit') on the ticket's project, with the bill photo. */
async function visitExpense(
  c: pg.PoolClient,
  actor: Actor,
  v: SiteVisit & { projectId: string },
  data: {
    cost: Paise;
    category: CostCategory;
    mode: 'cash' | 'upi' | 'bank';
    billPhotoId?: string | null | undefined;
  },
): Promise<string> {
  const today = todayIn();
  assertNotLocked(today, (await companyRow(c)).lock_date, 'cost');
  // BUG-154: a completed (handed-over) project takes visit costs; a cancelled one does not.
  await assertLiveProject(c, v.projectId, true);
  const id = randomUUID();
  if (data.billPhotoId) await claimAttachment(c, actor, data.billPhotoId, id);
  await c.query(
    `INSERT INTO expense (id, company_id, project_id, txn_date, particulars, category, amount, paid_by, mode,
                          account_code, attachment_id, source, source_id, ticket_id, status, created_by, updated_by)
     VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, 'visit', $11, $12, 'pending',
             app_user_id(), app_user_id())`,
    [
      id,
      v.projectId,
      today,
      `Service visit ${v.ticketNumber}: ${v.subject}`.slice(0, 500),
      data.category,
      toDecimalString(data.cost),
      v.engineerName,
      data.mode,
      ACCOUNT_FOR_MODE[data.mode],
      data.billPhotoId ?? null,
      v.id,
      v.ticketId,
    ],
  );
  await writeAudit(c, {
    action: 'create',
    entity: 'expense',
    entityId: id,
    after: { source: 'visit', visitId: v.id },
  });
  return id;
}
