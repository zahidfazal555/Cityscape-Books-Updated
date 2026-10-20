import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roleTemplate, type Actor } from '@csd/core';
import {
  OWNER_PASSWORD,
  client,
  closePools,
  emailOf,
  makeCompany,
  makeServices,
  makeUser,
  setPassword,
  superPool,
  tokenFrom,
  type Fixture,
} from './helpers.js';

const s = makeServices();
let f: Fixture;
let owner: Actor;
const NEW = 'Marina-Beach-Sunrise-77';

beforeAll(async () => {
  f = await makeCompany('Set Password Co');
  await setPassword(f.ownerId, OWNER_PASSWORD);
  const t = await s.auth.login(await emailOf(f.ownerId), OWNER_PASSWORD, client);
  owner = (await s.auth.authenticate(t.accessToken)).actor;
});
afterAll(closePools);

describe('owner sets a user password (Users & access)', () => {
  it('the user signs in with it; their sessions end, their invite link dies, it is audited', async () => {
    const email = `staff.${Date.now()}@example.test`;
    const userId = await s.users.create(owner, {
      name: 'Site Accounts',
      email,
      role: 'admin',
      projectsAll: true,
    });
    const invite = tokenFrom(s.mailer, email);

    await s.auth.setPasswordFor(owner, userId, NEW, client);
    const session = await s.auth.login(email, NEW, client);
    await s.auth.authenticate(session.accessToken);
    // The invite link sent earlier can no longer set a password.
    await expect(s.auth.redeemToken(invite, 'invite', 'Another-Long-Pass-91')).rejects.toThrow(
      'expired or was already used',
    );

    // Setting it again signs the user out everywhere.
    await s.auth.setPasswordFor(owner, userId, 'Kapaleeshwarar-Temple-12', client);
    await expect(s.auth.refresh(session.refreshToken, client)).rejects.toMatchObject({
      status: 401,
    });
    const { rows } = await superPool.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE company_id = $1 AND action = 'password_set_by_owner' AND entity_id = $2`,
      [f.companyId, userId],
    );
    expect(rows[0].n).toBe(2);
  });

  it('a locked-out user is unlocked by the new password', async () => {
    const userId = await makeUser(f.companyId, 'manager');
    await superPool.query(
      `UPDATE app_user SET failed_attempts = 5, locked_until = now() + interval '15 minutes' WHERE id = $1`,
      [userId],
    );
    await s.auth.setPasswordFor(owner, userId, NEW, client);
    await expect(s.auth.login(await emailOf(userId), NEW, client)).resolves.toBeTruthy();
  });

  it('the same password rules apply; only the owner may do it, for others', async () => {
    const userId = await makeUser(f.companyId, 'admin');
    await expect(s.auth.setPasswordFor(owner, userId, 'short', client)).rejects.toMatchObject({
      field: 'password',
    });
    await expect(
      s.auth.setPasswordFor(owner, userId, 'password123456', client),
    ).rejects.toMatchObject({ field: 'password' });

    const admin: Actor = {
      userId,
      companyId: f.companyId,
      role: 'admin',
      rights: roleTemplate('admin'),
      projects: 'all',
      active: true,
    };
    const other = await makeUser(f.companyId, 'manager');
    await expect(s.auth.setPasswordFor(admin, other, NEW, client)).rejects.toMatchObject({
      status: 403,
    });
    // Their own password needs the current one (changePassword), not this.
    await expect(s.auth.setPasswordFor(owner, f.ownerId, NEW, client)).rejects.toMatchObject({
      field: 'password',
    });
    // Another company's user does not exist for this owner.
    const elsewhere = await makeCompany('Other Co');
    await expect(
      s.auth.setPasswordFor(owner, elsewhere.ownerId, NEW, client),
    ).rejects.toMatchObject({ status: 404 });
  });
});
