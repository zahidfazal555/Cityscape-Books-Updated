import {
  DomainError,
  assertId,
  authorize,
  can,
  fromDecimalString,
  projectScope,
  stripPnl,
  toDecimalString,
  type Actor,
  type IsoDate,
  type Paise,
} from '@csd/core';
import { allocateNumber, withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { isoDate, parse, pick, tenantOf as ctx } from './validation.js';

export const PROJECT_STATUSES = ['active', 'on_hold', 'completed', 'cancelled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const paise = z
  .number()
  .int('Amount must be in paise.')
  .min(0, 'Amount cannot be negative.')
  .max(99_999_999_999_999);

const projectSchema = z.object({
  name: z.string().trim().min(1, 'Enter a project name.').max(160),
  clientId: z.string().uuid('Choose a client.'),
  siteAddress: z.string().trim().max(500).nullable().optional(),
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  contractValue: paise,
  costBudget: paise,
  managerId: z.string().uuid().nullable().optional(),
  engineerId: z.string().uuid().nullable().optional(),
});
const updateSchema = projectSchema
  .partial()
  .extend({ status: z.enum(PROJECT_STATUSES).optional() });

export type ProjectInput = z.input<typeof projectSchema>;
export type ProjectUpdate = z.input<typeof updateSchema>;

export interface Project {
  id: string;
  code: string;
  name: string;
  clientId: string;
  clientName: string;
  clientStateCode: string;
  siteAddress: string | null;
  status: ProjectStatus;
  startDate: IsoDate;
  endDate: IsoDate | null;
  contractValue: Paise;
  costBudget: Paise;
  managerId: string | null;
  engineerId: string | null;
}

const SELECT = `
  SELECT p.id, p.code, p.name, p.client_id, c.name AS client_name, c.state_code AS client_state_code,
         p.site_address, p.status, to_char(p.start_date, 'YYYY-MM-DD') AS start_date,
         to_char(p.end_date, 'YYYY-MM-DD') AS end_date, p.contract_value::text, p.cost_budget::text,
         p.manager_id, p.engineer_id
    FROM project p JOIN contact c ON c.id = p.client_id`;

interface Row {
  id: string;
  code: string;
  name: string;
  client_id: string;
  client_name: string;
  client_state_code: string;
  site_address: string | null;
  status: ProjectStatus;
  start_date: string;
  end_date: string | null;
  contract_value: string;
  cost_budget: string;
  manager_id: string | null;
  engineer_id: string | null;
}

const toProject = (r: Row): Project => ({
  id: r.id,
  code: r.code,
  name: r.name,
  clientId: r.client_id,
  clientName: r.client_name,
  clientStateCode: r.client_state_code,
  siteAddress: r.site_address,
  status: r.status,
  startDate: r.start_date,
  endDate: r.end_date,
  contractValue: fromDecimalString(r.contract_value),
  costBudget: fromDecimalString(r.cost_budget),
  managerId: r.manager_id,
  engineerId: r.engineer_id,
});

/** Allowed status changes. Reopening a completed or cancelled project needs `projects = full`. */
const TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  active: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['active', 'completed', 'cancelled'],
  completed: ['active'],
  cancelled: ['active'],
};

/** Projects (Req §4, FR-2.4 scoping). Out-of-scope projects answer 404, never 403. */
export class ProjectsService {
  constructor(private readonly pool: pg.Pool) {}

  async list(actor: Actor, status?: ProjectStatus): Promise<Project[]> {
    authorize(actor, 'projects', 'view');
    const scope = projectScope(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Row>(
        `${SELECT}
          WHERE ($1::uuid[] IS NULL OR p.id = ANY($1::uuid[])) AND ($2::text IS NULL OR p.status = $2)
          ORDER BY p.created_at DESC, p.code DESC`,
        [scope, status ?? null],
      );
      return stripPnl(actor, rows.map(toProject));
    });
  }

  async get(actor: Actor, id: string): Promise<Project> {
    authorize(actor, 'projects', 'view');
    assertId(id, 'Project');
    assertInScope(actor, id);
    return withTenant(this.pool, ctx(actor), async (c) =>
      stripPnl(actor, toProject(await getRow(c, id))),
    );
  }

  /** Creates CSD-PRJ-#### (gapless, same transaction). The client's state later drives GST. */
  async create(actor: Actor, input: ProjectInput): Promise<{ id: string; code: string }> {
    authorize(actor, 'projects', 'edit');
    const fields = newFields(parse(projectSchema, input));
    assertDates(fields.startDate, fields.endDate);
    return withTenant(this.pool, ctx(actor), async (c) => {
      await assertReferences(c, fields, null);
      const code = await allocateNumber(c, 'project', fields.startDate);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO project (company_id, code, name, client_id, site_address, status, start_date, end_date,
                              contract_value, cost_budget, manager_id, engineer_id, created_by)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, app_user_id()) RETURNING id`,
        [code, ...fieldParams(fields)],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error('project insert returned no id');
      // A scoped creator must be able to see what they just created.
      if (actor.projects !== 'all' && actor.role !== 'owner') {
        await c.query(
          'INSERT INTO user_project (company_id, user_id, project_id) VALUES (app_company_id(), app_user_id(), $1)',
          [id],
        );
        // A scope change is an access change: record it like any rights change.
        await writeAudit(c, {
          action: 'grant_scope',
          entity: 'user',
          entityId: actor.userId,
          after: { projectId: id, reason: 'creator of the project' },
        });
      }
      await writeAudit(c, {
        action: 'create',
        entity: 'project',
        entityId: id,
        after: { code, ...fields },
      });
      return { id, code };
    });
  }

  async update(actor: Actor, id: string, input: ProjectUpdate): Promise<void> {
    authorize(actor, 'projects', 'view');
    assertId(id, 'Project');
    assertInScope(actor, id);
    authorize(actor, 'projects', 'edit', id);
    const data = parse(updateSchema, input);
    await withTenant(this.pool, ctx(actor), async (c) => {
      const before = toProject(await getRow(c, id, true));
      const next = mergeFields(before, data);
      assertDates(next.startDate, next.endDate);
      if (next.status !== before.status) assertTransition(actor, before.status, next.status);
      await assertReferences(c, next, before);
      await c.query(
        `UPDATE project SET name = $2, client_id = $3, site_address = $4, status = $5, start_date = $6, end_date = $7,
                contract_value = $8, cost_budget = $9, manager_id = $10, engineer_id = $11 WHERE id = $1`,
        [id, ...fieldParams(next)],
      );
      const after = toProject(await getRow(c, id));
      await writeAudit(c, { action: 'update', entity: 'project', entityId: id, before, after });
    });
  }
}

type Fields = Pick<
  Project,
  | 'name'
  | 'clientId'
  | 'siteAddress'
  | 'status'
  | 'startDate'
  | 'endDate'
  | 'contractValue'
  | 'costBudget'
  | 'managerId'
  | 'engineerId'
>;

function newFields(d: z.output<typeof projectSchema>): Fields {
  return {
    name: d.name,
    clientId: d.clientId,
    siteAddress: d.siteAddress ?? null,
    status: 'active',
    startDate: d.startDate,
    endDate: d.endDate ?? null,
    contractValue: d.contractValue,
    costBudget: d.costBudget,
    managerId: d.managerId ?? null,
    engineerId: d.engineerId ?? null,
  };
}

/** Applies only the fields that were sent; `null` clears a nullable field. */
function mergeFields(before: Project, d: z.output<typeof updateSchema>): Fields {
  return {
    name: pick(d.name, before.name),
    clientId: pick(d.clientId, before.clientId),
    siteAddress: pick(d.siteAddress, before.siteAddress),
    status: pick(d.status, before.status),
    startDate: pick(d.startDate, before.startDate),
    endDate: pick(d.endDate, before.endDate),
    contractValue: pick(d.contractValue, before.contractValue),
    costBudget: pick(d.costBudget, before.costBudget),
    managerId: pick(d.managerId, before.managerId),
    engineerId: pick(d.engineerId, before.engineerId),
  };
}

function fieldParams(f: Fields): unknown[] {
  return [
    f.name,
    f.clientId,
    f.siteAddress,
    f.status,
    f.startDate,
    f.endDate,
    toDecimalString(f.contractValue),
    toDecimalString(f.costBudget),
    f.managerId,
    f.engineerId,
  ];
}

/** Checks only references that are new or changed. */
async function assertReferences(
  c: pg.PoolClient,
  next: Fields,
  before: Fields | null,
): Promise<void> {
  const live = (st: ProjectStatus): boolean => st === 'active' || st === 'on_hold';
  // Reopening must re-check the client: it may have been archived while the project was closed.
  const reopening = before !== null && live(next.status) && !live(before.status);
  if (next.clientId !== before?.clientId || reopening) await assertClient(c, next.clientId);
  if (next.managerId !== before?.managerId) await assertStaff(c, next.managerId, 'managerId');
  if (next.engineerId !== before?.engineerId) await assertStaff(c, next.engineerId, 'engineerId');
}

/** Out-of-scope projects answer 404 so their existence is not revealed. */
function assertInScope(actor: Actor, id: string): void {
  if (!can(actor, 'projects', 'view', id)) throw new DomainError('NOT_FOUND', 'Project not found.');
}

function assertDates(start: IsoDate, end: IsoDate | null): void {
  if (end !== null && end < start) {
    throw new DomainError('VALIDATION', 'The end date cannot be before the start date.', 'endDate');
  }
}

function assertTransition(actor: Actor, from: ProjectStatus, to: ProjectStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new DomainError(
      'VALIDATION',
      `A ${from.replace('_', ' ')} project cannot be set to ${to.replace('_', ' ')}.`,
      'status',
    );
  }
  if ((from === 'completed' || from === 'cancelled') && !can(actor, 'projects', 'full')) {
    throw new DomainError('FORBIDDEN', 'Only users with full project rights can reopen a project.');
  }
}

/** `forUpdate` locks the project so concurrent edits and status changes serialise. */
async function getRow(c: pg.PoolClient, id: string, forUpdate = false): Promise<Row> {
  const { rows } = await c.query<Row>(
    `${SELECT} WHERE p.id = $1${forUpdate ? ' FOR UPDATE OF p' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'Project not found.');
  return row;
}

async function assertClient(c: pg.PoolClient, clientId: string): Promise<void> {
  const ok = await c.query(
    // FOR SHARE: an archive of this client waits until the project is committed (and then sees it).
    `SELECT 1 FROM contact WHERE id = $1 AND type = 'client' AND deleted_at IS NULL FOR SHARE`,
    [clientId],
  );
  if (ok.rowCount !== 1)
    throw new DomainError('VALIDATION', 'Choose an existing client.', 'clientId');
}

async function assertStaff(c: pg.PoolClient, userId: string | null, field: string): Promise<void> {
  if (userId === null) return;
  const ok = await c.query(
    `SELECT 1 FROM app_user WHERE id = $1 AND is_active AND role <> 'auditor'`,
    [userId],
  );
  if (ok.rowCount !== 1)
    throw new DomainError('VALIDATION', 'Choose an active team member.', field);
}
