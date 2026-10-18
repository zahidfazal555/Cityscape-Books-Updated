import {
  DomainError,
  TICKET_CHANNELS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  assertId,
  authorize,
  can,
  canMoveTicket,
  coverageFor,
  projectScope,
  todayIn,
  type Actor,
  type Coverage,
  type IsoDate,
  type TicketChannel,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from '@csd/core';
import { allocateNumber, withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { blankToNull, companyRow, parse, tenantOf as ctx } from './validation.js';

const ticketSchema = z.object({
  projectId: z.string().uuid('Choose a project.'),
  type: z.enum(TICKET_TYPES),
  subject: z.string().trim().min(1, 'Enter the subject.').max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  priority: z.enum(TICKET_PRIORITIES).default('normal'),
  channel: z.enum(TICKET_CHANNELS),
  callerName: z.preprocess(blankToNull, z.string().trim().max(120).nullable().optional()),
  callerPhone: z.preprocess(
    blankToNull,
    z
      .string()
      .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number.')
      .nullable()
      .optional(),
  ),
  assigneeId: z.string().uuid().nullable().optional(),
});
const updateSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  chargeable: z.boolean().optional(),
});
const eventSchema = z.object({
  kind: z.enum(['reply', 'call', 'note']),
  body: z.string().trim().min(1, 'Write something first.').max(4000),
});
const ratingSchema = z.object({
  rating: z.number().int().min(1, 'Pick 1 to 5 stars.').max(5, 'Pick 1 to 5 stars.'),
  comment: z.string().trim().max(1000).nullable().optional(),
});

export type TicketInput = z.input<typeof ticketSchema>;
export type TicketUpdate = z.input<typeof updateSchema>;
export const TICKET_VIEWS = [
  'open',
  'mine',
  'breached',
  'unassigned',
  'resolved',
  'closed',
  'all',
] as const;
export type TicketView = (typeof TICKET_VIEWS)[number];

export interface TicketSummary {
  id: string;
  number: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  clientId: string;
  clientName: string;
  type: TicketType;
  subject: string;
  priority: TicketPriority;
  status: TicketStatus;
  channel: TicketChannel;
  coverage: Coverage;
  chargeable: boolean;
  assigneeId: string | null;
  assigneeName: string | null;
  createdAt: string;
  respDue: string;
  resolveDue: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /** Response or resolution target passed without being met. */
  breached: boolean;
}

export interface TicketEvent {
  id: string;
  kind: 'system' | 'reply' | 'call' | 'note';
  body: string;
  authorName: string | null;
  createdAt: string;
}

export interface TicketDetail extends TicketSummary {
  description: string | null;
  callerName: string | null;
  callerPhone: string | null;
  siteAddress: string | null;
  handoverDate: IsoDate | null;
  warrantyMonths: number;
  amcUntil: IsoDate | null;
  rating: number | null;
  ratingComment: string | null;
  events: TicketEvent[];
}

interface Row {
  id: string;
  number: string;
  project_id: string;
  project_code: string;
  project_name: string;
  client_id: string;
  client_name: string;
  type: TicketType;
  subject: string;
  priority: TicketPriority;
  status: TicketStatus;
  channel: TicketChannel;
  coverage: Coverage;
  chargeable: boolean;
  assignee_id: string | null;
  assignee_name: string | null;
  created_at: Date;
  resp_due: Date;
  resolve_due: Date;
  first_response_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  breached: boolean;
  description: string | null;
  caller_name: string | null;
  caller_phone: string | null;
  site_address: string | null;
  handover_date: string | null;
  warranty_months: number;
  amc_until: string | null;
  rating: number | null;
  rating_comment: string | null;
}

/** Breached: a target passed unmet (response, or resolution while still unresolved). */
const BREACHED = `coalesce(
  (t.first_response_at IS NULL AND t.resolved_at IS NULL AND t.resp_due < now())
  OR (t.first_response_at > t.resp_due)
  OR (coalesce(t.resolved_at, now()) > t.resolve_due), false)`;
const OPEN = `t.status NOT IN ('resolved', 'closed')`;

const SELECT = `
  SELECT t.id, t.number, t.project_id, p.code AS project_code, p.name AS project_name, c.id AS client_id, c.name AS client_name,
         t.type, t.subject, t.priority, t.status, t.channel, t.coverage, t.chargeable, t.assignee_id,
         u.name AS assignee_name, t.created_at, t.resp_due, t.resolve_due, t.first_response_at, t.resolved_at,
         t.closed_at, (${OPEN} AND ${BREACHED}) AS breached, t.description, t.caller_name, t.caller_phone,
         p.site_address, to_char(p.handover_date, 'YYYY-MM-DD') AS handover_date, p.warranty_months,
         to_char(p.amc_until, 'YYYY-MM-DD') AS amc_until, t.rating, t.rating_comment
    FROM ticket t
    JOIN project p ON p.id = t.project_id
    JOIN contact c ON c.id = p.client_id
    LEFT JOIN app_user u ON u.id = t.assignee_id`;

const VIEW_SQL: Record<TicketView, string> = {
  open: OPEN,
  mine: `${OPEN} AND t.assignee_id = app_user_id()`,
  breached: `${OPEN} AND ${BREACHED}`,
  unassigned: `${OPEN} AND t.assignee_id IS NULL`,
  resolved: `t.status = 'resolved'`,
  closed: `t.status = 'closed'`,
  all: 'true',
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const toSummary = (r: Row): TicketSummary => ({
  id: r.id,
  number: r.number,
  projectId: r.project_id,
  projectCode: r.project_code,
  projectName: r.project_name,
  clientId: r.client_id,
  clientName: r.client_name,
  type: r.type,
  subject: r.subject,
  priority: r.priority,
  status: r.status,
  channel: r.channel,
  coverage: r.coverage,
  chargeable: r.chargeable,
  assigneeId: r.assignee_id,
  assigneeName: r.assignee_name,
  createdAt: r.created_at.toISOString(),
  respDue: r.resp_due.toISOString(),
  resolveDue: r.resolve_due.toISOString(),
  firstResponseAt: iso(r.first_response_at),
  resolvedAt: iso(r.resolved_at),
  closedAt: iso(r.closed_at),
  breached: r.breached,
});

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  awaiting_client: 'Awaiting client',
  visit_scheduled: 'Visit scheduled',
  resolved: 'Resolved',
  closed: 'Closed',
};

export async function systemEvent(c: pg.PoolClient, ticketId: string, body: string): Promise<void> {
  await c.query(
    `INSERT INTO ticket_event (company_id, ticket_id, kind, body, author_id)
     VALUES (app_company_id(), $1, 'system', $2, app_user_id())`,
    [ticketId, body],
  );
}

/** A ticket in the actor's scope, locked for update when asked. */
export async function loadTicket(
  c: pg.PoolClient,
  actor: Actor,
  id: string,
  forUpdate = false,
): Promise<TicketDetail> {
  assertId(id, 'Ticket');
  const { rows } = await c.query<Row>(
    `${SELECT} WHERE t.id = $1${forUpdate ? ' FOR UPDATE OF t' : ''}`,
    [id],
  );
  const r = rows[0];
  if (!r || !can(actor, 'tickets', 'view', r.project_id))
    throw new DomainError('NOT_FOUND', 'Ticket not found.');
  return {
    ...toSummary(r),
    description: r.description,
    callerName: r.caller_name,
    callerPhone: r.caller_phone,
    siteAddress: r.site_address,
    handoverDate: r.handover_date,
    warrantyMonths: r.warranty_months,
    amcUntil: r.amc_until,
    rating: r.rating,
    ratingComment: r.rating_comment,
    events: [],
  };
}

/** Support tickets (Req §4.19): an internal service desk; clients never log in. */
export class TicketsService {
  constructor(private readonly pool: pg.Pool) {}

  /** The queue: breached first, then priority, then oldest (FR-19.6). */
  async list(actor: Actor, view: TicketView = 'open'): Promise<TicketSummary[]> {
    authorize(actor, 'tickets', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      await notifySla(c);
      const { rows } = await c.query<Row>(
        `${SELECT} WHERE (${VIEW_SQL[view]}) AND ($1::uuid[] IS NULL OR t.project_id = ANY($1::uuid[]))
         ORDER BY (${OPEN} AND ${BREACHED}) DESC,
                  array_position(ARRAY['urgent','high','normal','low'], t.priority), t.created_at
         LIMIT 1000`,
        [projectScope(actor)],
      );
      return rows.filter((r) => can(actor, 'tickets', 'view', r.project_id)).map(toSummary);
    });
  }

  /** Cards and view-chip counts (FR-19.6). */
  async counts(actor: Actor): Promise<Record<TicketView | 'visits' | 'awaiting', number>> {
    authorize(actor, 'tickets', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      await notifySla(c);
      const cols = TICKET_VIEWS.map((v) => `count(*) FILTER (WHERE ${VIEW_SQL[v]})::int AS ${v}`);
      const { rows } = await c.query<Record<string, number>>(
        `SELECT ${cols.join(', ')},
                count(*) FILTER (WHERE t.status = 'visit_scheduled')::int AS visits,
                count(*) FILTER (WHERE t.status = 'awaiting_client')::int AS awaiting
           FROM ticket t WHERE $1::uuid[] IS NULL OR t.project_id = ANY($1::uuid[])`,
        [projectScope(actor)],
      );
      return rows[0] as Record<TicketView | 'visits' | 'awaiting', number>;
    });
  }

  /** "Log ticket" (FR-19.2); coverage is decided now and stored (FR-19.7). */
  async create(actor: Actor, input: TicketInput): Promise<{ id: string; number: string }> {
    const data = parse(ticketSchema, input);
    authorize(actor, 'tickets', 'edit', data.projectId);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const project = await projectWarranty(c, data.projectId);
      if (data.assigneeId) await assertHandler(c, data.assigneeId);
      const coverage = coverageFor(data.type, project, todayIn());
      const company = await companyRow(c);
      const number = await allocateNumber(c, 'ticket', todayIn(), company.fy_start_month);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO ticket (company_id, number, project_id, type, subject, description, priority, channel, caller_name,
                             caller_phone, assignee_id, coverage, chargeable, created_by, resp_due, resolve_due)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, app_user_id(), now(), now())
         RETURNING id`,
        [
          number,
          data.projectId,
          data.type,
          data.subject,
          data.description ?? null,
          data.priority,
          data.channel,
          data.callerName ?? null,
          data.callerPhone ?? null,
          data.assigneeId ?? null,
          coverage,
          coverage === 'chargeable',
        ],
      );
      const id = rows[0]?.id;
      if (!id) throw new DomainError('CONFLICT', 'The ticket was not saved.');
      await systemEvent(c, id, `Ticket logged (${COVERAGE_LABEL[coverage]})`);
      // BUG-158 (§9): caller details are anonymised after 3 years; the append-only audit log
      // must not keep a copy of them.
      const { callerName, callerPhone, ...rest } = data;
      await writeAudit(c, {
        action: 'create',
        entity: 'ticket',
        entityId: id,
        after: { ...rest, coverage, caller: Boolean(callerName || callerPhone) },
      });
      return { id, number };
    });
  }

  async get(actor: Actor, id: string): Promise<TicketDetail> {
    authorize(actor, 'tickets', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const t = await loadTicket(c, actor, id);
      const { rows } = await c.query<{
        id: string;
        kind: TicketEvent['kind'];
        body: string;
        author_name: string | null;
        created_at: Date;
      }>(
        `SELECT e.id, e.kind, e.body, u.name AS author_name, e.created_at
           FROM ticket_event e LEFT JOIN app_user u ON u.id = e.author_id
          WHERE e.ticket_id = $1 ORDER BY e.seq`,
        [id],
      );
      const events = rows.map((e) => ({
        id: e.id,
        kind: e.kind,
        body: e.body,
        authorName: e.author_name,
        createdAt: e.created_at.toISOString(),
      }));
      return { ...t, events };
    });
  }

  /** Status, priority, assignee and the chargeable toggle (FR-19.3, FR-19.10). */
  async update(actor: Actor, id: string, input: TicketUpdate): Promise<void> {
    const data = parse(updateSchema, input);
    authorize(actor, 'tickets', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const t = await loadTicket(c, actor, id, true);
      authorize(actor, 'tickets', 'edit', t.projectId);
      if (data.status !== undefined && data.status !== t.status)
        await moveStatus(c, t, data.status);
      if (data.priority !== undefined && data.priority !== t.priority) {
        await c.query(`UPDATE ticket SET priority = $2, updated_by = app_user_id() WHERE id = $1`, [
          id,
          data.priority,
        ]);
        await systemEvent(c, id, `Priority set to ${data.priority}`);
      }
      if (data.assigneeId !== undefined && data.assigneeId !== t.assigneeId)
        await assign(c, id, data.assigneeId);
      if (data.chargeable !== undefined && data.chargeable !== t.chargeable) {
        await c.query(
          `UPDATE ticket SET chargeable = $2, updated_by = app_user_id() WHERE id = $1`,
          [id, data.chargeable],
        );
        await systemEvent(c, id, data.chargeable ? 'Marked chargeable' : 'Marked free of charge');
      }
      await writeAudit(c, { action: 'update', entity: 'ticket', entityId: id, after: data });
    });
  }

  /** Reply to client, call log or internal note; the first reply or call stamps the response (FR-19.5). */
  async addEvent(actor: Actor, id: string, input: z.input<typeof eventSchema>): Promise<void> {
    const data = parse(eventSchema, input);
    authorize(actor, 'tickets', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const t = await loadTicket(c, actor, id, true);
      authorize(actor, 'tickets', 'edit', t.projectId);
      await c.query(
        `INSERT INTO ticket_event (company_id, ticket_id, kind, body, author_id)
         VALUES (app_company_id(), $1, $2, $3, app_user_id())`,
        [id, data.kind, data.body],
      );
      if (data.kind !== 'note' && !t.firstResponseAt)
        await c.query(`UPDATE ticket SET first_response_at = now() WHERE id = $1`, [id]);
    });
  }

  /** FR-19.11: 1–5 stars from the closing call, once Resolved or Closed. */
  async rate(actor: Actor, id: string, input: z.input<typeof ratingSchema>): Promise<void> {
    const data = parse(ratingSchema, input);
    authorize(actor, 'tickets', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const t = await loadTicket(c, actor, id, true);
      authorize(actor, 'tickets', 'edit', t.projectId);
      if (t.status !== 'resolved' && t.status !== 'closed')
        throw new DomainError('CONFLICT', 'Rate a ticket once it is resolved or closed.');
      await c.query(
        `UPDATE ticket SET rating = $2, rating_comment = $3, rating_by = app_user_id(), rating_at = now(),
                updated_by = app_user_id() WHERE id = $1`,
        [id, data.rating, data.comment ?? null],
      );
      await systemEvent(c, id, `Customer rating ${data.rating}/5 recorded`);
    });
  }

  /** Active site engineers, for scheduling visits (FR-19.9). */
  async engineers(actor: Actor): Promise<{ id: string; name: string }[]> {
    authorize(actor, 'tickets', 'edit');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM app_user WHERE is_active AND role = 'site' ORDER BY name`,
      );
      return rows;
    });
  }

  /** Users who can handle tickets, for the assignee chips. */
  async handlers(actor: Actor): Promise<{ id: string; name: string }[]> {
    authorize(actor, 'tickets', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM app_user WHERE is_active AND role IN ('owner', 'asstmgr', 'manager', 'admin')
          ORDER BY role = 'owner' DESC, name`,
      );
      return rows;
    });
  }
}

export const COVERAGE_LABEL: Record<Coverage, string> = {
  warranty: 'in warranty, free',
  amc: 'covered by AMC',
  contract: 'not handed over, fixed under the contract',
  chargeable: 'chargeable',
  na: 'billing query',
};

async function projectWarranty(c: pg.PoolClient, projectId: string) {
  const { rows } = await c.query<{
    handover: string | null;
    months: number;
    amc: string | null;
    status: string;
  }>(
    `SELECT to_char(handover_date, 'YYYY-MM-DD') AS handover, warranty_months AS months,
            to_char(amc_until, 'YYYY-MM-DD') AS amc, status
       FROM project WHERE id = $1`,
    [projectId],
  );
  const p = rows[0];
  if (!p) throw new DomainError('VALIDATION', 'Choose a project.', 'projectId');
  if (p.status === 'cancelled')
    throw new DomainError('VALIDATION', 'The project is cancelled.', 'projectId');
  return { handoverDate: p.handover, warrantyMonths: p.months, amcUntil: p.amc };
}

async function assertHandler(c: pg.PoolClient, userId: string): Promise<void> {
  const { rows } = await c.query(
    `SELECT 1 FROM app_user WHERE id = $1 AND is_active AND role <> 'site' AND role <> 'auditor'`,
    [userId],
  );
  if (rows.length === 0)
    throw new DomainError('VALIDATION', 'Choose someone who handles tickets.', 'assigneeId');
}

async function assign(c: pg.PoolClient, id: string, assigneeId: string | null): Promise<void> {
  if (assigneeId) await assertHandler(c, assigneeId);
  await c.query(`UPDATE ticket SET assignee_id = $2, updated_by = app_user_id() WHERE id = $1`, [
    id,
    assigneeId,
  ]);
  const { rows } = await c.query<{ name: string }>(`SELECT name FROM app_user WHERE id = $1`, [
    assigneeId,
  ]);
  await systemEvent(c, id, rows[0] ? `Assigned to ${rows[0].name}` : 'Unassigned');
}

/**
 * FR-19.3. "Visit scheduled" is set only by scheduling a visit. Resolving needs no visit still
 * scheduled and stamps the response if none was logged; reopening clears resolved time and rating.
 */
async function moveStatus(c: pg.PoolClient, t: TicketDetail, to: TicketStatus): Promise<void> {
  if (to === 'visit_scheduled')
    throw new DomainError('VALIDATION', 'Schedule a site visit to set this status.', 'status');
  if (!canMoveTicket(t.status, to))
    throw new DomainError(
      'CONFLICT',
      `A ticket cannot go from ${STATUS_LABEL[t.status]} to ${STATUS_LABEL[to]}.`,
    );
  const done = to === 'resolved' || to === 'closed';
  if (done) {
    const v = await c.query(
      `SELECT 1 FROM site_visit WHERE ticket_id = $1 AND status = 'scheduled'`,
      [t.id],
    );
    if (v.rowCount)
      throw new DomainError('CONFLICT', 'Complete or cancel the scheduled visit first.');
  }
  const reopen = !done && (t.status === 'resolved' || t.status === 'closed');
  await c.query(
    `UPDATE ticket SET status = $2,
            first_response_at = CASE WHEN $3 THEN coalesce(first_response_at, now()) ELSE first_response_at END,
            resolved_at = CASE WHEN $4 THEN NULL WHEN $3 THEN coalesce(resolved_at, now()) ELSE resolved_at END,
            closed_at = CASE WHEN $2 = 'closed' THEN now() WHEN $4 THEN NULL ELSE closed_at END,
            rating = CASE WHEN $4 THEN NULL ELSE rating END,
            rating_comment = CASE WHEN $4 THEN NULL ELSE rating_comment END,
            rating_by = CASE WHEN $4 THEN NULL ELSE rating_by END,
            rating_at = CASE WHEN $4 THEN NULL ELSE rating_at END,
            updated_by = app_user_id()
      WHERE id = $1`,
    [t.id, to, done, reopen],
  );
  await systemEvent(
    c,
    t.id,
    `${reopen ? 'Reopened: ' : ''}${STATUS_LABEL[t.status]} → ${STATUS_LABEL[to]}`,
  );
}

/**
 * Notifications for breached tickets and tickets due soon (README §18), once per ticket, clock and
 * state (BUG-160: the response and resolution clocks each notify): to the assignee, or to the
 * Owner when unassigned. Idempotent by key; run on every notification read and queue load.
 */
export async function notifySla(c: pg.PoolClient): Promise<void> {
  await c.query(
    `WITH clock AS (
       SELECT t.id, t.number, t.subject,
              coalesce(t.assignee_id, (SELECT id FROM app_user WHERE role = 'owner' LIMIT 1)) AS to_user,
              k.name, k.due, k.due - t.created_at AS target
         FROM ticket t
         CROSS JOIN LATERAL (VALUES ('resp', t.resp_due, t.first_response_at IS NULL AND t.resolved_at IS NULL),
                                    ('resolve', t.resolve_due, t.resolved_at IS NULL)) AS k(name, due, running)
        WHERE ${OPEN} AND k.running),
     due AS (
       SELECT *, CASE WHEN due < now() THEN 'breach' WHEN due - now() <= target / 4 THEN 'soon' END AS state
         FROM clock)
     INSERT INTO notification (company_id, user_id, key, type, title, body, link)
     SELECT app_company_id(), d.to_user, 'sla:' || d.id || ':' || d.name || ':' || d.state, 'sla',
            d.number || CASE WHEN d.state = 'breach' THEN ' is overdue' ELSE ' is due soon' END,
            CASE WHEN d.name = 'resp' THEN 'No response yet: ' ELSE 'Not resolved yet: ' END || d.subject,
            '/tickets/' || d.id
       FROM due d WHERE d.state IS NOT NULL AND d.to_user IS NOT NULL
     ON CONFLICT (user_id, key) DO NOTHING`,
  );
}
