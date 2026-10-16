import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { BAD_LOGIN } from '../src/index.js';
import {
  OWNER_PASSWORD,
  client,
  closePools,
  emailOf,
  makeCompany,
  makeServices,
  setPassword,
  superPool,
  tokenFrom,
  type Fixture,
} from './helpers.js';

const s = makeServices();
let f: Fixture;
let ownerEmail: string;

beforeAll(async () => {
  f = await makeCompany('Auth Co');
  await setPassword(f.ownerId, OWNER_PASSWORD);
  ownerEmail = await emailOf(f.ownerId);
});
afterAll(closePools);

const login = () => s.auth.login(ownerEmail, OWNER_PASSWORD, client);

describe('sign-in', () => {
  it('signs in with email + password and authenticates the access token', async () => {
    const t = await s.auth.login(ownerEmail.toUpperCase(), OWNER_PASSWORD, client);
    const { actor } = await s.auth.authenticate(t.accessToken);
    expect(actor).toMatchObject({
      userId: f.ownerId,
      companyId: f.companyId,
      role: 'owner',
      active: true,
    });
  });

  it('gives the same message for a wrong password and an unknown email', async () => {
    await expect(s.auth.login(ownerEmail, 'wrong-password-xyz', client)).rejects.toMatchObject({
      status: 401,
      message: BAD_LOGIN,
    });
    await expect(
      s.auth.login('nobody@nowhere.test', 'whatever-password', client),
    ).rejects.toMatchObject({
      status: 401,
      message: BAD_LOGIN,
    });
  });

  it('rejects forged and foreign-key access tokens', async () => {
    await expect(s.auth.authenticate('not.a.jwt')).rejects.toMatchObject({ status: 401 });
    const forged = await new SignJWT({ cid: f.companyId, sid: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(f.ownerId)
      .setIssuer('cityscape-books')
      .setExpirationTime('5m')
      .sign(new Uint8Array(32));
    await expect(s.auth.authenticate(forged)).rejects.toMatchObject({ status: 401 });
  });

  it('locks after 5 failures, tells the owner, and refuses even the right password', async () => {
    const victim = await s.users.create(await ownerActor(), {
      name: 'Accounts Admin',
      email: 'admin.lock@example.test',
      role: 'admin',
      projectsAll: true,
    });
    await setPassword(victim, 'Correct-Horse-Battery-9');
    for (let i = 0; i < 5; i++) {
      await expect(
        s.auth.login('admin.lock@example.test', 'nope-nope-nope', client),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      s.auth.login('admin.lock@example.test', 'Correct-Horse-Battery-9', client),
    ).rejects.toThrow(BAD_LOGIN);
    const { rows } = await superPool.query(
      `SELECT type, title FROM notification WHERE user_id = $1 AND type = 'security'`,
      [f.ownerId],
    );
    expect(rows).toContainEqual({
      type: 'security',
      title: 'Account locked after 5 failed sign-ins',
    });
    const audit = await superPool.query(
      `SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'lockout'`,
      [victim],
    );
    expect(audit.rowCount).toBe(1);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens; replaying an old one revokes every session (token theft)', async () => {
    const first = await login();
    const second = await s.auth.refresh(first.refreshToken, client);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(s.auth.authenticate(second.accessToken)).resolves.toBeDefined();
    // Older than the 60-second race window: a replay, not two tabs.
    await superPool.query(
      `UPDATE session_rotated SET rotated_at = now() - interval '2 minutes' WHERE user_id = $1`,
      [f.ownerId],
    );
    await expect(s.auth.refresh(first.refreshToken, client)).rejects.toMatchObject({ status: 401 });
    await expect(s.auth.refresh(second.refreshToken, client)).rejects.toMatchObject({
      status: 401,
    });
    await expect(s.auth.authenticate(second.accessToken)).rejects.toMatchObject({ status: 401 });
    const reuse = await superPool.query(
      `SELECT 1 FROM audit_log WHERE action = 'refresh_token_reuse' AND user_id = $1`,
      [f.ownerId],
    );
    expect(reuse.rowCount).toBeGreaterThan(0);
  });

  it('ends a session after 30 minutes without activity', async () => {
    const t = await login();
    await superPool.query(
      `UPDATE session SET last_seen_at = now() - interval '31 minutes' WHERE user_id = $1 AND revoked_at IS NULL`,
      [f.ownerId],
    );
    await expect(s.auth.refresh(t.refreshToken, client)).rejects.toThrow('30 minutes idle');
  });

  it('logout revokes the session and its access token', async () => {
    const t = await login();
    await s.auth.logout(t.refreshToken);
    await expect(s.auth.authenticate(t.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(s.auth.logout('unknown-token')).resolves.toBeUndefined();
  });
});

describe('invites, resets and password policy', () => {
  it('invite → set password → sign in; the link is single-use', async () => {
    await s.users.create(await ownerActor(), {
      name: 'Shiva',
      email: 'shiva.invite@example.test',
      role: 'manager',
      projectsAll: true,
    });
    const token = tokenFrom(s.mailer, 'shiva.invite@example.test');
    await s.auth.redeemToken(token, 'invite', 'Marina-beach-walk-77');
    await expect(
      s.auth.login('shiva.invite@example.test', 'Marina-beach-walk-77', client),
    ).resolves.toBeDefined();
    await expect(s.auth.redeemToken(token, 'invite', 'Another-pass-phrase-1')).rejects.toThrow(
      'This link has expired or was already used.',
    );
  });

  it('a reset token cannot be used as an invite, and expired tokens fail', async () => {
    await s.auth.requestPasswordReset(ownerEmail);
    const token = tokenFrom(s.mailer, ownerEmail);
    await expect(
      s.auth.redeemToken(token, 'invite', 'Sunrise-over-Adyar-43'),
    ).rejects.toMatchObject({ status: 422 });
    await superPool.query(
      `UPDATE auth_token SET expires_at = now() - interval '1 second' WHERE user_id = $1`,
      [f.ownerId],
    );
    await expect(s.auth.redeemToken(token, 'reset', 'Sunrise-over-Adyar-43')).rejects.toMatchObject(
      { status: 422 },
    );
  });

  it('forgot-password never reveals whether an email exists', async () => {
    const before = s.mailer.outbox.length;
    await expect(s.auth.requestPasswordReset('ghost@nowhere.test')).resolves.toBeUndefined();
    expect(s.mailer.outbox.length).toBe(before);
  });

  it('a password reset signs the user out everywhere', async () => {
    const t = await login();
    await s.auth.requestPasswordReset(ownerEmail);
    await s.auth.redeemToken(tokenFrom(s.mailer, ownerEmail), 'reset', OWNER_PASSWORD + '!');
    await expect(s.auth.authenticate(t.accessToken)).rejects.toMatchObject({ status: 401 });
    await setPassword(f.ownerId, OWNER_PASSWORD);
  });

  it('enforces length, personal-detail, repetition and breach rules', async () => {
    const t = await login();
    const { actor } = await s.auth.authenticate(t.accessToken);
    const change = (p: string) => s.auth.changePassword(actor, OWNER_PASSWORD, p, client);
    await expect(change('short-1')).rejects.toThrow('at least 12');
    await expect(change('Welcome@12345')).rejects.toThrow('data breach');
    await expect(change('aaaaaaaaaaaaaaaa')).rejects.toThrow('less repetitive');
    await expect(change(`${ownerEmail.split('@')[0]}-secret-99`)).rejects.toThrow('name or email');
    await expect(
      s.auth.changePassword(actor, 'wrong-current-pw', 'Fine-new-pass-99', client),
    ).rejects.toThrow('Current password is incorrect.');
  });
});

describe('access lifecycle (UAT 12)', () => {
  it('a deactivated user is signed out at once and cannot sign in; reactivation restores access', async () => {
    const owner = await ownerActor();
    const id = await s.users.create(owner, {
      name: 'Leaver',
      email: 'leaver@example.test',
      role: 'site',
      projectsAll: true,
    });
    await setPassword(id, 'Leaving-soon-pass-1');
    const t = await s.auth.login('leaver@example.test', 'Leaving-soon-pass-1', client);
    await s.users.setActive(owner, id, false);
    await expect(s.auth.authenticate(t.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(
      s.auth.login('leaver@example.test', 'Leaving-soon-pass-1', client),
    ).rejects.toThrow(BAD_LOGIN);
    await s.users.setActive(owner, id, true);
    await expect(
      s.auth.login('leaver@example.test', 'Leaving-soon-pass-1', client),
    ).resolves.toBeDefined();
  });

  it('auditor access stops at its expiry date', async () => {
    const owner = await ownerActor();
    const id = await s.users.create(owner, {
      name: 'CA Firm',
      email: 'ca@example.test',
      role: 'auditor',
      projectsAll: true,
      accessExpiresAt: new Date(Date.now() + 86_400_000),
    });
    await setPassword(id, 'Audit-season-2027');
    await expect(
      s.auth.login('ca@example.test', 'Audit-season-2027', client),
    ).resolves.toBeDefined();
    await superPool.query(
      `UPDATE app_user SET access_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    await expect(
      s.auth.login('ca@example.test', 'Audit-season-2027', client),
    ).rejects.toMatchObject({ status: 401 });
  });
});

async function ownerActor() {
  const t = await login();
  return (await s.auth.authenticate(t.accessToken)).actor;
}
