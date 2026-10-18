import {
  DomainError,
  LEVELS,
  MODULES,
  roleTemplate,
  type Actor,
  type Level,
  type Module,
  type Role,
} from '@csd/core';
import type pg from 'pg';

/**
 * Loads the authenticated user's rights and project scope inside a tenant transaction.
 * Missing permission rows fall back to the role template (owner always has everything).
 */
export async function loadActor(client: pg.PoolClient, userId: string): Promise<Actor> {
  const { rows } = await client.query<{
    company_id: string;
    role: Role;
    projects_all: boolean;
    is_active: boolean;
    access_expires_at: Date | null;
  }>(
    'SELECT company_id, role, projects_all, is_active, access_expires_at FROM app_user WHERE id = $1',
    [userId],
  );
  const user = rows[0];
  if (!user) throw new DomainError('UNAUTHENTICATED', 'Please sign in again.');

  const rights: Record<Module, Level> = { ...roleTemplate(user.role) };
  const perms = await client.query<{ module: Module; level: Level }>(
    'SELECT module, level FROM user_permission WHERE user_id = $1',
    [userId],
  );
  for (const p of perms.rows) {
    if (
      (MODULES as readonly string[]).includes(p.module) &&
      (LEVELS as readonly string[]).includes(p.level)
    ) {
      rights[p.module] = p.level;
    }
  }

  let projects: Actor['projects'] = 'all';
  if (!user.projects_all && user.role !== 'owner') {
    const scoped = await client.query<{ project_id: string }>(
      'SELECT project_id FROM user_project WHERE user_id = $1',
      [userId],
    );
    projects = scoped.rows.map((r) => r.project_id);
  }

  const expired = user.access_expires_at !== null && user.access_expires_at.getTime() <= Date.now();
  return {
    userId,
    companyId: user.company_id,
    role: user.role,
    rights,
    projects,
    active: user.is_active && !expired,
  };
}
