import {
  DomainError,
  MODULES,
  assertId,
  hasCustomRights,
  roleTemplate,
  validateRights,
  type Actor,
  type Rights,
  type Role,
} from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { revokeUserSessions, type AuthService } from './auth.js';
import type { MailMessage } from './mailer.js';
import { isUniqueViolation, parse } from './validation.js';

/** Users & security is owner-only and cannot be granted (Tech Spec §5). */
export function assertOwner(actor: Actor): void {
  if (actor.role !== 'owner' || !actor.active) {
    throw new DomainError('FORBIDDEN', 'Only the owner can manage users and security.');
  }
}

const ASSIGNABLE_ROLES = ['admin', 'manager', 'asstmgr', 'site', 'auditor'] as const;

const userFields = {
  name: z.string().trim().min(1, 'Enter a name or role title.').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid work email.').max(254),
  phone: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number.')
    .nullable()
    .optional(),
  role: z.enum(ASSIGNABLE_ROLES),
  projectsAll: z.boolean(),
  projectIds: z.array(z.string().uuid()).default([]),
  permissions: z.record(z.string(), z.string()).optional(),
  accessExpiresAt: z.coerce.date().nullable().optional(),
};

export const createUserSchema = z.object(userFields);
export const updateUserSchema = z.object(userFields).partial();
export type CreateUserInput = z.input<typeof createUserSchema>;
export type UpdateUserInput = z.input<typeof updateUserSchema>;

export interface UserRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  isActive: boolean;
  projectsAll: boolean;
  projectIds: string[];
  rights: Rights;
  rightsLabel: 'Full access' | 'Role default' | 'Custom rights';
  lastLoginAt: Date | null;
  accessExpiresAt: Date | null;
  invitePending: boolean;
}

interface Resolved {
  role: Role;
  rights: Rights;
  projectsAll: boolean;
  projectIds: string[];
  accessExpiresAt: Date | null;
}

function resolveAccess(input: {
  role: Role;
  permissions?: Record<string, string> | undefined;
  projectsAll: boolean;
  projectIds: string[];
  accessExpiresAt?: Date | null | undefined;
}): Resolved {
  const rights = input.permissions ? validateRights(input.permissions) : roleTemplate(input.role);
  if (input.role === 'auditor') assertAuditorAccess(rights, input.accessExpiresAt);
  if (!input.projectsAll && input.projectIds.length === 0) {
    throw new DomainError(
      'VALIDATION',
      'Pick at least one project, or allow all projects.',
      'projectIds',
    );
  }
  return {
    role: input.role,
    rights,
    projectsAll: input.projectsAll,
    projectIds: input.projectsAll ? [] : [...new Set(input.projectIds)],
    accessExpiresAt: input.role === 'auditor' ? (input.accessExpiresAt ?? null) : null,
  };
}

function assertAuditorAccess(rights: Rights, expiresAt: Date | null | undefined): void {
  if (!expiresAt) {
    throw new DomainError('VALIDATION', 'Set when the auditor’s access ends.', 'accessExpiresAt');
  }
  const writable = MODULES.find((m) => rights[m] === 'edit' || rights[m] === 'full');
  if (writable) {
    throw new DomainError(
      'VALIDATION',
      'An auditor can only have view access.',
      `permissions.${writable}`,
    );
  }
}

type StoredUser = Awaited<ReturnType<typeof getUser>>;

/** Applies a partial edit over the stored user. A role change without rights resets to the template. */
function mergeAccess(before: StoredUser, data: z.output<typeof updateUserSchema>): Resolved {
  const role = data.role ?? before.role;
  return resolveAccess({
    role,
    permissions: data.permissions ?? (role === before.role ? before.rights : undefined),
    projectsAll: data.projectsAll ?? before.projectsAll,
    projectIds: data.projectIds ?? before.projectIds,
    accessExpiresAt:
      data.accessExpiresAt === undefined ? before.accessExpiresAt : data.accessExpiresAt,
  });
}

function accessChanged(before: StoredUser, access: Resolved): boolean {
  const sameProjects =
    JSON.stringify([...access.projectIds].sort()) === JSON.stringify([...before.projectIds].sort());
  return (
    access.role !== before.role ||
    access.projectsAll !== before.projectsAll ||
    (access.accessExpiresAt?.getTime() ?? null) !== (before.accessExpiresAt?.getTime() ?? null) ||
    !sameProjects ||
    MODULES.some((m) => access.rights[m] !== before.rights[m])
  );
}

/** Owner admin panel: create, edit rights, scope, deactivate (handbook §7.5 joiner/mover/leaver). */
export class UsersService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly auth: AuthService,
  ) {}

  async list(actor: Actor): Promise<UserRow[]> {
    assertOwner(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{
        id: string;
        name: string;
        email: string;
        phone: string | null;
        role: Role;
        is_active: boolean;
        projects_all: boolean;
        last_login_at: Date | null;
        access_expires_at: Date | null;
        invite_pending: boolean;
        project_ids: string[] | null;
        perms: Record<string, string> | null;
      }>(`
        SELECT u.id, u.name, u.email, u.phone, u.role, u.is_active, u.projects_all, u.last_login_at,
               u.access_expires_at, (u.password_hash IS NULL) AS invite_pending,
               (SELECT array_agg(project_id::text) FROM user_project p WHERE p.user_id = u.id) AS project_ids,
               (SELECT jsonb_object_agg(module, level) FROM user_permission p WHERE p.user_id = u.id) AS perms
          FROM app_user u
         ORDER BY (u.role = 'owner') DESC, u.is_active DESC, u.name`);
      return rows.map((r) => {
        const rights =
          r.role === 'owner'
            ? roleTemplate('owner')
            : ({ ...roleTemplate(r.role), ...(r.perms ?? {}) } as Rights);
        return {
          id: r.id,
          name: r.name,
          email: r.email,
          phone: r.phone,
          role: r.role,
          isActive: r.is_active,
          projectsAll: r.projects_all,
          projectIds: r.project_ids ?? [],
          rights,
          rightsLabel:
            r.role === 'owner'
              ? 'Full access'
              : hasCustomRights(r.role, rights)
                ? 'Custom rights'
                : 'Role default',
          lastLoginAt: r.last_login_at,
          accessExpiresAt: r.access_expires_at,
          invitePending: r.invite_pending,
        };
      });
    });
  }

  /** Creates the user with the role's rights (or custom ones) and emails an invite link. */
  async create(actor: Actor, input: CreateUserInput): Promise<string> {
    assertOwner(actor);
    const data = parse(createUserSchema, input);
    const access = resolveAccess(data);
    const result = await withTenant(this.pool, ctx(actor), async (c) => {
      await assertProjectsExist(c, access.projectIds);
      const { rows } = await c
        .query<{ id: string }>(
          `INSERT INTO app_user (company_id, name, email, phone, role, projects_all, access_expires_at, created_by)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, app_user_id()) RETURNING id`,
          [
            data.name,
            data.email,
            data.phone ?? null,
            access.role,
            access.projectsAll,
            access.accessExpiresAt,
          ],
        )
        .catch((e: unknown) => {
          throw isUniqueViolation(e)
            ? new DomainError('VALIDATION', 'A user with this email already exists.', 'email')
            : e;
        });
      const id = rows[0]?.id;
      if (!id) throw new Error('user insert returned no id');
      await writeAccess(c, id, access);
      await writeAudit(c, {
        action: 'create',
        entity: 'user',
        entityId: id,
        after: { ...data, ...access },
      });
      return { id, mail: await this.auth.issueToken(c, id, 'invite') };
    });
    this.auth.sendAfterCommit([result.mail]);
    return result.id;
  }

  /**
   * Edits a user. Changing the role resets rights to the new role's template unless rights are
   * sent too. Any change to role, rights or scope signs the user out (mover rule).
   */
  async update(actor: Actor, userId: string, input: UpdateUserInput): Promise<void> {
    assertOwner(actor);
    assertId(userId, 'User');
    const data = parse(updateUserSchema, input);
    const mails: MailMessage[] = [];
    await withTenant(this.pool, ctx(actor), async (c) => {
      const before = await getUser(c, userId);
      if (before.role === 'owner')
        throw new DomainError('FORBIDDEN', 'The owner account always has full access.');
      const access = mergeAccess(before, data);
      await assertProjectsExist(c, access.projectIds);
      await c
        .query(
          `UPDATE app_user SET name = $2, email = $3, phone = $4, role = $5, projects_all = $6, access_expires_at = $7
          WHERE id = $1`,
          [
            userId,
            data.name ?? before.name,
            data.email ?? before.email,
            data.phone === undefined ? before.phone : data.phone,
            access.role,
            access.projectsAll,
            access.accessExpiresAt,
          ],
        )
        .catch((e: unknown) => {
          throw isUniqueViolation(e)
            ? new DomainError('VALIDATION', 'A user with this email already exists.', 'email')
            : e;
        });
      await writeAccess(c, userId, access);
      const emailChanged = data.email !== undefined && data.email !== before.email.toLowerCase();
      if (emailChanged) mails.push(...(await this.onEmailChanged(c, userId)));
      if (emailChanged || accessChanged(before, access)) await revokeUserSessions(c, userId);
      const after = await getUser(c, userId);
      await writeAudit(c, { action: 'update', entity: 'user', entityId: userId, before, after });
    });
    this.auth.sendAfterCommit(mails);
  }

  /**
   * Links already mailed to the old address must stop working. A user who has not accepted
   * the invite yet gets a fresh one at the new address.
   */
  private async onEmailChanged(c: pg.PoolClient, userId: string): Promise<MailMessage[]> {
    await c.query('UPDATE auth_token SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [
      userId,
    ]);
    const { rows } = await c.query<{ pending: boolean }>(
      'SELECT password_hash IS NULL AS pending FROM app_user WHERE id = $1',
      [userId],
    );
    return rows[0]?.pending ? [await this.auth.issueToken(c, userId, 'invite')] : [];
  }

  /** Deactivated users cannot sign in; their records and audit entries stay (UAT 12). */
  async setActive(actor: Actor, userId: string, active: boolean): Promise<void> {
    assertOwner(actor);
    assertId(userId, 'User');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const before = await getUser(c, userId);
      if (before.role === 'owner')
        throw new DomainError('FORBIDDEN', 'The owner account cannot be deactivated.');
      await c.query('UPDATE app_user SET is_active = $2 WHERE id = $1', [userId, active]);
      if (!active) await revokeUserSessions(c, userId);
      await writeAudit(c, {
        action: active ? 'activate' : 'deactivate',
        entity: 'user',
        entityId: userId,
        before: { isActive: before.isActive },
        after: { isActive: active },
      });
    });
  }

  async resendInvite(actor: Actor, userId: string): Promise<void> {
    assertOwner(actor);
    assertId(userId, 'User');
    const mail = await withTenant(this.pool, ctx(actor), async (c) => {
      const u = await getUser(c, userId);
      if (!u.isActive) throw new DomainError('VALIDATION', 'Activate the user first.');
      await writeAudit(c, { action: 'invite_sent', entity: 'user', entityId: userId });
      return this.auth.issueToken(c, userId, 'invite');
    });
    this.auth.sendAfterCommit([mail]);
  }
}

const ctx = (actor: Actor): { companyId: string; userId: string } => ({
  companyId: actor.companyId,
  userId: actor.userId,
});

async function getUser(
  c: pg.PoolClient,
  userId: string,
): Promise<Omit<UserRow, 'rightsLabel' | 'invitePending' | 'lastLoginAt'>> {
  const { rows } = await c.query<{
    id: string;
    name: string;
    email: string;
    phone: string | null;
    role: Role;
    is_active: boolean;
    projects_all: boolean;
    access_expires_at: Date | null;
  }>(
    'SELECT id, name, email, phone, role, is_active, projects_all, access_expires_at FROM app_user WHERE id = $1',
    [userId],
  );
  const u = rows[0];
  if (!u) throw new DomainError('NOT_FOUND', 'User not found.');
  const perms = await c.query<{ module: string; level: string }>(
    'SELECT module, level FROM user_permission WHERE user_id = $1',
    [userId],
  );
  const projects = await c.query<{ project_id: string }>(
    'SELECT project_id FROM user_project WHERE user_id = $1',
    [userId],
  );
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    isActive: u.is_active,
    projectsAll: u.projects_all,
    projectIds: projects.rows.map((p) => p.project_id),
    rights: {
      ...roleTemplate(u.role),
      ...Object.fromEntries(perms.rows.map((p) => [p.module, p.level])),
    } as Rights,
    accessExpiresAt: u.access_expires_at,
  };
}

async function writeAccess(c: pg.PoolClient, userId: string, access: Resolved): Promise<void> {
  await c.query('DELETE FROM user_permission WHERE user_id = $1', [userId]);
  await c.query(
    `INSERT INTO user_permission (company_id, user_id, module, level)
     SELECT app_company_id(), $1, m, l FROM unnest($2::text[], $3::text[]) AS t(m, l)`,
    [userId, [...MODULES], MODULES.map((m) => access.rights[m])],
  );
  await c.query('DELETE FROM user_project WHERE user_id = $1', [userId]);
  if (access.projectIds.length > 0) {
    await c.query(
      `INSERT INTO user_project (company_id, user_id, project_id)
       SELECT app_company_id(), $1, unnest($2::uuid[])`,
      [userId, access.projectIds],
    );
  }
}

async function assertProjectsExist(c: pg.PoolClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { rows } = await c.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM project WHERE id = ANY($1::uuid[])',
    [ids],
  );
  if (rows[0]?.n !== ids.length)
    throw new DomainError('VALIDATION', 'One of the chosen projects does not exist.', 'projectIds');
}
