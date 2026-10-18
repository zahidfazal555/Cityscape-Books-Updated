import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  AuthService,
  BAD_LOGIN,
  UsersService,
  SettingsService,
  type MailMessage,
  type Mailer,
} from '../src/index.js';
import {
  FakeBreach,
  appPool,
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
let n = 0;
const PW = 'Strong-pass-phrase-88';

beforeAll(async () => {
  f = await makeCompany('Regress Co');
  await setPassword(f.ownerId, PW);
});
afterAll(closePools);
afterEach(() => vi.useRealTimers());

async function owner() {
  const t = await s.auth.login(await emailOf(f.ownerId), PW, {
    ...client,
    deviceId: 'owner-laptop',
  });
  return (await s.auth.authenticate(t.accessToken)).actor;
}
async function newUser(
  role: 'admin' | 'manager' | 'site' = 'manager',
  extra: Record<string, unknown> = {},
) {
  const email = `r${++n}@regress.example.test`;
  const id = await s.users.create(await owner(), {
    name: `User ${n}`,
    email,
    role,
    projectsAll: true,
    ...extra,
  });
  await setPassword(id, PW);
  return { id, email };
}
const count = async (sql: string, params: unknown[]) =>
  (await superPool.query(sql, params)).rowCount ?? 0;

describe('third review regressions (auth)', () => {
  it('BUG-017: a rejected password does not burn the invite link', async () => {
    const email = `invitee${++n}@regress.example.test`;
    await s.users.create(await owner(), {
      name: 'Invitee',
      email,
      role: 'site',
      projectsAll: true,
    });
    const token = tokenFrom(s.mailer, email);
    await expect(s.auth.redeemToken(token, 'invite', 'short')).rejects.toThrow('at least 12');
    await expect(s.auth.redeemToken(token, 'invite', 'Welcome@12345')).rejects.toThrow(
      'data breach',
    );
    await expect(
      s.auth.redeemToken(token, 'invite', 'Kapaleeshwarar-temple-9'),
    ).resolves.toBeUndefined();
  });

  it('BUG-018: a concurrent burst cannot get past the lockout, and a correct guess does not clear it', async () => {
    const u = await newUser();
    const results = await Promise.allSettled([
      ...Array.from({ length: 11 }, () => s.auth.login(u.email, 'wrong-guess-123', client)),
      s.auth.login(u.email, PW, client),
    ]);
    const wins = results.filter((r) => r.status === 'fulfilled').length;
    expect(wins).toBeLessThanOrEqual(1);
    const { rows } = await superPool.query<{ locked: boolean }>(
      'SELECT locked_until > now() AS locked FROM app_user WHERE id = $1',
      [u.id],
    );
    expect(rows[0]!.locked).toBe(true);
    await expect(s.auth.login(u.email, PW, client)).rejects.toThrow(BAD_LOGIN);
  });

  it('BUG-189: a concurrent burst of password-change guesses cannot get past the lockout', async () => {
    const u = await newUser();
    const t = await s.auth.login(u.email, PW, client);
    const { actor } = await s.auth.authenticate(t.accessToken);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        s.auth.changePassword(actor, 'wrong-guess-123', 'Marina-beach-sunrise-42', client),
      ),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    // Guesses are checked one at a time: 4 failures, the 5th locks, the other 7 are refused
    // without being checked. Before the fix all 12 were checked against the password.
    expect(
      await count(
        `SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'password_change' AND outcome = 'failed'`,
        [u.id],
      ),
    ).toBe(4);
    await expect(
      s.auth.changePassword(actor, PW, 'Marina-beach-sunrise-42', client),
    ).rejects.toMatchObject({ field: 'currentPassword' });
  });

  it('BUG-019: replaying any old refresh token is detected, and sessions do not slide past 7 days', async () => {
    const u = await newUser();
    const t1 = await s.auth.login(u.email, PW, client);
    const t2 = await s.auth.refresh(t1.refreshToken, client);
    await superPool.query(
      `UPDATE session_rotated SET rotated_at = now() - interval '2 minutes' WHERE user_id = $1`,
      [u.id],
    );
    const t3 = await s.auth.refresh(t2.refreshToken, client);
    expect(t3.refreshExpiresAt.getTime()).toBe(t1.refreshExpiresAt.getTime());
    await expect(s.auth.refresh(t1.refreshToken, client)).rejects.toMatchObject({ status: 401 });
    await expect(s.auth.refresh(t3.refreshToken, client)).rejects.toMatchObject({ status: 401 });
    await expect(s.auth.authenticate(t3.accessToken)).rejects.toMatchObject({ status: 401 });
  });

  it('BUG-020: two tabs refreshing at once get a 409 retry, not a global sign-out', async () => {
    const u = await newUser();
    const t1 = await s.auth.login(u.email, PW, client);
    const t2 = await s.auth.refresh(t1.refreshToken, client);
    await expect(s.auth.refresh(t1.refreshToken, client)).rejects.toMatchObject({ status: 409 });
    await expect(s.auth.authenticate(t2.accessToken)).resolves.toBeDefined();
    await expect(s.auth.refresh(t2.refreshToken, client)).resolves.toBeDefined();
  });

  it('BUG-021: changing an email kills links sent to the old address and re-invites at the new one', async () => {
    const o = await owner();
    const typo = `typo${++n}@exmaple.test`;
    const id = await s.users.create(o, {
      name: 'Typo',
      email: typo,
      role: 'site',
      projectsAll: true,
    });
    const oldToken = tokenFrom(s.mailer, typo);
    const fixed = `fixed${n}@regress.example.test`;
    await s.users.update(o, id, { email: fixed });
    await expect(s.auth.redeemToken(oldToken, 'invite', 'Guindy-park-walk-11')).rejects.toThrow(
      'expired or was already used',
    );
    await expect(
      s.auth.redeemToken(tokenFrom(s.mailer, fixed), 'invite', 'Guindy-park-walk-11'),
    ).resolves.toBeUndefined();
  });

  it('BUG-022: an expired auditor’s refresh actually revokes the session', async () => {
    const o = await owner();
    const email = `aud${++n}@regress.example.test`;
    const id = await s.users.create(o, {
      name: 'Auditor',
      email,
      role: 'auditor',
      projectsAll: true,
      accessExpiresAt: new Date(Date.now() + 1e8),
    });
    await setPassword(id, PW);
    const t = await s.auth.login(email, PW, client);
    await superPool.query(
      `UPDATE app_user SET access_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    await expect(s.auth.refresh(t.refreshToken, client)).rejects.toMatchObject({ status: 401 });
    expect(
      await count('SELECT 1 FROM session WHERE user_id = $1 AND revoked_at IS NULL', [id]),
    ).toBe(0);
  });

  it('BUG-023: a locked account answers exactly like an unknown one', async () => {
    const u = await newUser();
    for (let i = 0; i < 5; i++)
      await s.auth.login(u.email, 'nope-nope-nope', client).catch(() => undefined);
    const locked = await s.auth.login(u.email, PW, client).catch((e: Error) => e.message);
    const unknown = await s.auth
      .login('ghost@nowhere.test', PW, client)
      .catch((e: Error) => e.message);
    expect(locked).toBe(unknown);
  });

  it('BUG-024: idle time counts from the last request, and idle access tokens are refused', async () => {
    const u = await newUser();
    const t = await s.auth.login(u.email, PW, client);
    await superPool.query(
      `UPDATE session SET last_seen_at = now() - interval '20 minutes' WHERE user_id = $1`,
      [u.id],
    );
    await s.auth.authenticate(t.accessToken); // activity at t=20 min
    await expect(s.auth.refresh(t.refreshToken, client)).resolves.toBeDefined();
    await superPool.query(
      `UPDATE session SET last_seen_at = now() - interval '31 minutes' WHERE user_id = $1`,
      [u.id],
    );
    await expect(s.auth.authenticate(t.accessToken)).rejects.toMatchObject({ status: 401 });
  });

  it('BUG-025/026: failed sign-ins record the IP, and a burst writes exactly one lockout', async () => {
    const u = await newUser();
    for (let i = 0; i < 7; i++) {
      await s.auth
        .login(u.email, 'nope-nope-nope', { ip: '192.0.2.55', userAgent: 'x' })
        .catch(() => undefined);
    }
    const { rows } = await superPool.query<{ action: string; ip: string | null }>(
      `SELECT action, host(ip) AS ip FROM audit_log WHERE entity_id = $1 AND action IN ('login', 'lockout') ORDER BY id`,
      [u.id],
    );
    expect(rows.filter((r) => r.action === 'lockout')).toHaveLength(1);
    expect(rows.every((r) => r.ip === '192.0.2.55')).toBe(true);
    expect(
      await count(`SELECT 1 FROM notification WHERE key LIKE 'lockout:' || $1 || ':%'`, [u.id]),
    ).toBe(1);
  });

  it('BUG-027: mail failures never fail the request or reveal that an account exists', async () => {
    const errors: string[] = [];
    const failing: Mailer = {
      send: async (_m: MailMessage) => Promise.reject(new Error('SMTP 503')),
    };
    const auth = new AuthService({
      pool: appPool,
      config: { jwtSecret: randomBytes(32), appUrl: 'https://x.test' },
      breach: new FakeBreach(),
      mailer: failing,
      onMailError: (_e, subject) => errors.push(subject),
    });
    const users = new UsersService(appPool, auth);
    await expect(auth.requestPasswordReset(await emailOf(f.ownerId))).resolves.toBeUndefined();
    await expect(auth.requestPasswordReset('ghost@nowhere.test')).resolves.toBeUndefined();
    await expect(
      users.create(await owner(), {
        name: 'Mailless',
        email: `m${++n}@regress.example.test`,
        role: 'site',
        projectsAll: true,
      }),
    ).resolves.toBeTypeOf('string');
    await vi.waitFor(() => expect(errors.length).toBe(2));
    expect(new SettingsService(appPool)).toBeDefined();
  });

  it('BUG-028: wrong current passwords in change-password count toward the lockout', async () => {
    const u = await newUser();
    const t = await s.auth.login(u.email, PW, client);
    const { actor } = await s.auth.authenticate(t.accessToken);
    for (let i = 0; i < 5; i++) {
      await expect(
        s.auth.changePassword(actor, `guess-${i}-guess-guess`, 'New-pass-phrase-99', client),
      ).rejects.toMatchObject({ status: 422 });
    }
    const { rows } = await superPool.query<{ locked: boolean }>(
      'SELECT locked_until > now() AS locked FROM app_user WHERE id = $1',
      [u.id],
    );
    expect(rows[0]!.locked).toBe(true);
    await expect(
      s.auth.changePassword(actor, PW, 'New-pass-phrase-99', client),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('BUG-029: an Admin sign-in from a new device on a known IP alerts the owner in-app and by email', async () => {
    const u = await newUser('admin');
    await s.auth.login(u.email, PW, { ...client, deviceId: 'office-pc' });
    await s.auth.login(u.email, PW, { ...client, deviceId: 'office-pc' });
    const before = await count(
      `SELECT 1 FROM notification WHERE type = 'security' AND title = 'New sign-in' AND body LIKE '%' || $1 || '%'`,
      [`User ${n}`],
    );
    expect(before).toBe(0);
    await s.auth.login(u.email, PW, { ...client, deviceId: 'unknown-laptop' });
    const { rows } = await superPool.query<{ body: string }>(
      `SELECT body FROM notification WHERE title = 'New sign-in' AND body LIKE '%' || $1 || '%'`,
      [`User ${n}`],
    );
    expect(rows[0]!.body).toBe(`The Admin account (User ${n}) signed in from a new device.`);
    const ownerEmail = await emailOf(f.ownerId);
    expect(
      s.mailer.outbox.some(
        (m) => m.to === ownerEmail && m.subject === 'Cityscape Books: new sign-in',
      ),
    ).toBe(true);
  });

  it('BUG-030: the owner can lock today at 01:30 IST', async () => {
    const o = await owner();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T20:00:00Z'));
    await expect(s.settings.setLockDate(o, '2026-10-31')).resolves.toBeUndefined();
    await expect(s.settings.setLockDate(o, '2026-11-01')).rejects.toThrow('future');
    vi.useRealTimers();
    await s.settings.setLockDate(o, null);
  });

  it('BUG-031: malformed user ids answer 404, not a database error', async () => {
    const o = await owner();
    await expect(s.users.update(o, 'abc', { name: 'X' })).rejects.toMatchObject({ status: 404 });
    await expect(s.users.setActive(o, 'abc', false)).rejects.toMatchObject({ status: 404 });
    await expect(s.users.resendInvite(o, 'abc')).rejects.toMatchObject({ status: 404 });
  });
});

describe('review regressions (PR 17, auth)', () => {
  it('BUG-163: a background request (the notification poll) does not count as activity', async () => {
    const t = await s.auth.login(await emailOf(f.ownerId), PW, {
      ...client,
      deviceId: 'owner-laptop',
    });
    await superPool.query(
      `UPDATE session SET last_seen_at = now() - interval '10 minutes' WHERE user_id = $1`,
      [f.ownerId],
    );
    const seen = async () =>
      (
        await superPool.query<{ m: number }>(
          `SELECT extract(epoch FROM now() - max(last_seen_at))::int AS m FROM session WHERE user_id = $1`,
          [f.ownerId],
        )
      ).rows[0]!.m;
    await s.auth.authenticate(t.accessToken, { background: true });
    expect(await seen()).toBeGreaterThanOrEqual(590);
    await s.auth.authenticate(t.accessToken);
    expect(await seen()).toBeLessThan(5);
  });
});
