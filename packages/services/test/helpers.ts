import { randomBytes } from 'node:crypto';
import {
  AuthService,
  MemoryMailer,
  UsersService,
  SettingsService,
  hashPassword,
  type BreachChecker,
} from '../src/index.js';
import { appPool, superPool } from '../../db/test/helpers.js';

export {
  appPool,
  superPool,
  closePools,
  makeCompany,
  type Fixture,
} from '../../db/test/helpers.js';

export const OWNER_PASSWORD = 'Sunrise-over-Adyar-42';

export class FakeBreach implements BreachChecker {
  readonly breached = new Set(['password123456', 'Welcome@12345']);
  async isBreached(p: string): Promise<boolean> {
    return this.breached.has(p);
  }
}

export function makeServices() {
  const mailer = new MemoryMailer();
  const auth = new AuthService({
    pool: appPool,
    config: { jwtSecret: randomBytes(32), appUrl: 'https://books.example.test' },
    breach: new FakeBreach(),
    mailer,
  });
  return {
    mailer,
    auth,
    users: new UsersService(appPool, auth),
    settings: new SettingsService(appPool),
  };
}

export async function setPassword(userId: string, password: string): Promise<void> {
  await superPool.query('UPDATE app_user SET password_hash = $2 WHERE id = $1', [
    userId,
    await hashPassword(password),
  ]);
}

export async function emailOf(userId: string): Promise<string> {
  const { rows } = await superPool.query<{ email: string }>(
    'SELECT email FROM app_user WHERE id = $1',
    [userId],
  );
  return rows[0]!.email;
}

/** Pulls the token out of the last email sent to `to`. */
export function tokenFrom(mailer: MemoryMailer, to: string): string {
  const msg = [...mailer.outbox].reverse().find((m) => m.to === to);
  const match = msg && /token=([A-Za-z0-9_-]+)/.exec(msg.text);
  if (!match?.[1]) throw new Error(`no token mailed to ${to}`);
  return match[1];
}

export const client = { ip: '203.0.113.7', userAgent: 'vitest' };

import { roleTemplate, type Actor, type Role } from '@csd/core';

/** An actor with a role's template rights, optionally scoped to projects. */
export function actorFor(
  f: { companyId: string },
  userId: string,
  role: Role,
  projects: Actor['projects'] = 'all',
): Actor {
  return {
    userId,
    companyId: f.companyId,
    role,
    rights: roleTemplate(role),
    projects,
    active: true,
  };
}

/** Creates a real user row so audit and created_by references resolve. */
export async function makeUser(
  companyId: string,
  role: Role,
  name: string = role,
): Promise<string> {
  const { rows } = await superPool.query<{ id: string }>(
    `INSERT INTO app_user (company_id, name, email, role, access_expires_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'auditor' THEN now() + interval '30 days' END) RETURNING id`,
    [
      companyId,
      name,
      `${role}.${Date.now()}.${Math.random().toString(36).slice(2)}@example.test`,
      role,
    ],
  );
  return rows[0]!.id;
}
