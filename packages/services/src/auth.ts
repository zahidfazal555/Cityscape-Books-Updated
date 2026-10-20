import { DomainError, assertId, type Actor } from '@csd/core';
import {
  mapDbError,
  withTenant,
  writeAudit,
  writeAuditDetached,
  type TenantContext,
} from '@csd/db';
import { SignJWT, jwtVerify } from 'jose';
import type pg from 'pg';
import { loadActor } from './actor.js';
import { randomToken, sha256 } from './crypto.js';
import type { MailMessage, Mailer } from './mailer.js';
import {
  assertPasswordPolicy,
  dummyVerify,
  hashPassword,
  verifyPassword,
  type BreachChecker,
} from './passwords.js';

export interface AuthConfig {
  /** HS256 signing key, ≥ 32 bytes, from the secret manager. */
  jwtSecret: Uint8Array;
  appUrl: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  idleTimeoutSeconds?: number;
}

export interface AuthDeps {
  pool: pg.Pool;
  config: AuthConfig;
  breach: BreachChecker;
  mailer: Mailer;
  /** Called when a mail could not be sent after commit. Never receives token links. */
  onMailError?: (error: unknown, subject: string) => void;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
  /** Random id from a long-lived cookie, for new-device alerts. */
  deviceId?: string | null;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface AccessClaims {
  userId: string;
  companyId: string;
  sessionId: string;
}

/** One message for every failed sign-in: never reveals whether an account exists or is locked. */
export const BAD_LOGIN =
  'Email or password is incorrect. After 5 failed attempts, sign-in is paused for 15 minutes.';
const SIGN_IN_AGAIN = 'Please sign in again.';
const ISSUER = 'cityscape-books';
const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin' };

interface AttemptRow {
  id: string;
  company_id: string;
  email: string;
  name: string;
  password_hash: string | null;
  role: string;
  is_active: boolean;
  access_expires_at: Date | null;
  locked: boolean;
}

type Attempt =
  | { kind: 'ok'; user: AttemptRow }
  | { kind: 'fail'; user: AttemptRow | undefined; justLocked: boolean; denied: boolean };

const unauth = (message = SIGN_IN_AGAIN): DomainError =>
  new DomainError('UNAUTHENTICATED', message);

/** Sign-in, sessions and password lifecycle (Tech Spec §7, ENGINEERING-STANDARDS §2, H1). */
export class AuthService {
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly idleTimeout: number;

  constructor(private readonly deps: AuthDeps) {
    if (deps.config.jwtSecret.byteLength < 32)
      throw new Error('jwtSecret must be at least 32 bytes');
    this.accessTtl = deps.config.accessTtlSeconds ?? 15 * 60;
    this.refreshTtl = deps.config.refreshTtlSeconds ?? 7 * 24 * 3600;
    this.idleTimeout = deps.config.idleTimeoutSeconds ?? 30 * 60;
  }

  /** Email + password, single step. */
  async login(email: string, password: string, client: ClientInfo): Promise<Tokens> {
    const attempt = await this.attempt(email.trim(), password);
    if (attempt.kind === 'fail') {
      await this.recordFailedAttempt(attempt, client);
      throw unauth(BAD_LOGIN);
    }
    const { user } = attempt;
    const mails: MailMessage[] = [];
    const tokens = await withTenant(this.deps.pool, ctxOf(user), async (c) => {
      mails.push(...(await this.newDeviceAlert(c, user, client)));
      await writeAudit(c, { action: 'login', entity: 'user', entityId: user.id, ip: client.ip });
      return this.createSession(c, user.id, user.company_id, client);
    });
    this.sendAfterCommit(mails);
    return tokens;
  }

  /**
   * Rotates the refresh token. Sessions last at most 7 days from sign-in (no sliding). Replaying
   * any rotated-out token revokes every session of the user, except a benign race (latest
   * rotation, under 60 s), which answers 409 so the client retries with its new cookie.
   */
  async refresh(refreshToken: string, client: ClientInfo): Promise<Tokens> {
    const { pool } = this.deps;
    const hash = sha256(refreshToken);
    const found = await pool.query<{
      id: string;
      company_id: string;
      user_id: string;
      expires_at: Date;
      last_seen_at: Date;
    }>('SELECT id, company_id, user_id, expires_at, last_seen_at FROM auth_find_session($1)', [
      hash,
    ]);
    const session = found.rows[0];
    if (!session) return this.handleUnknownRefresh(hash, client);
    const ctx = { companyId: session.company_id, userId: session.user_id };
    const active = await withTenant(
      pool,
      ctx,
      async (c) => (await loadActor(c, session.user_id)).active,
    );
    if (this.isIdle(session.last_seen_at) || !active) {
      await this.revokeSession(ctx, session.id);
      throw unauth(
        active ? 'Your session ended after 30 minutes idle. Please sign in again.' : SIGN_IN_AGAIN,
      );
    }
    const next = randomToken();
    await withTenant(pool, ctx, async (c) => {
      const updated = await c.query(
        `UPDATE session SET refresh_token_hash = $2
          WHERE id = $1 AND refresh_token_hash = $3 AND revoked_at IS NULL`,
        [session.id, sha256(next), hash],
      );
      if (updated.rowCount !== 1) throw raceError();
      await c.query(
        `INSERT INTO session_rotated (token_hash, session_id, company_id, user_id)
         VALUES ($1, $2, app_company_id(), $3)`,
        [hash, session.id, session.user_id],
      );
    });
    return {
      accessToken: await this.signAccess({ ...ctx, sessionId: session.id }),
      refreshToken: next,
      refreshExpiresAt: session.expires_at,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const found = await this.deps.pool.query<{ id: string; company_id: string; user_id: string }>(
      'SELECT id, company_id, user_id FROM auth_find_session($1)',
      [sha256(refreshToken)],
    );
    const s = found.rows[0];
    if (!s) return;
    await withTenant(this.deps.pool, { companyId: s.company_id, userId: s.user_id }, async (c) => {
      await c.query('UPDATE session SET revoked_at = now() WHERE id = $1', [s.id]);
      await writeAudit(c, { action: 'logout', entity: 'user', entityId: s.user_id });
    });
  }

  /**
   * Verifies a 15-minute access token, confirms its session is live and not idle, and records
   * activity. Only real requests count as activity, so a client refreshing on a timer is still
   * signed out after 30 minutes idle. `background` requests (the notification poll) never count
   * (BUG-163), or an open tab would keep the session alive for ever (H1).
   */
  async authenticate(
    accessToken: string,
    opts: { background?: boolean } = {},
  ): Promise<{ claims: AccessClaims; actor: Actor }> {
    const claims = await this.verifyAccess(accessToken);
    const ctx = { companyId: claims.companyId, userId: claims.userId };
    const actor = await withTenant(this.deps.pool, ctx, async (c) => {
      const live = await c.query<{ last_seen_at: Date }>(
        `SELECT last_seen_at FROM session
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
        [claims.sessionId, claims.userId],
      );
      const lastSeen = live.rows[0]?.last_seen_at;
      if (!lastSeen || this.isIdle(lastSeen)) throw unauth();
      if (!opts.background)
        await c.query(
          `UPDATE session SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`,
          [claims.sessionId],
        );
      return loadActor(c, claims.userId);
    });
    if (!actor.active) throw unauth();
    return { claims, actor };
  }

  /**
   * Wrong current passwords count toward the lockout. The check runs with the user row locked
   * and the failure is recorded before the lock is released, so concurrent guesses are
   * serialised and can never exceed the 5-failure limit, as at sign-in (BUG-189). The policy
   * check and hashing of the new password run outside any transaction. Success signs the user
   * out everywhere.
   */
  async changePassword(
    actor: Actor,
    currentPassword: string,
    newPassword: string,
    client: ClientInfo,
  ): Promise<void> {
    const ctx = { companyId: actor.companyId, userId: actor.userId };
    const check = await withTenant(this.deps.pool, ctx, (c) =>
      this.checkCurrentPassword(c, actor.userId, currentPassword),
    );
    if (!check.ok) {
      if (check.failed) await this.afterFailure(ctx, check.locked, 'password_change', client);
      throw new DomainError('VALIDATION', 'Current password is incorrect.', 'currentPassword');
    }
    const u = check.user;
    await assertPasswordPolicy(newPassword, u, this.deps.breach);
    const newHash = await hashPassword(newPassword);
    await withTenant(this.deps.pool, ctx, async (c) => {
      const res = await c.query(
        'UPDATE app_user SET password_hash = $2, password_changed_at = now() WHERE id = $1 AND password_hash = $3',
        [actor.userId, newHash, u.password_hash],
      );
      if (res.rowCount !== 1)
        throw new DomainError('CONFLICT', 'Your password was changed elsewhere. Sign in again.');
      await revokeUserSessions(c, actor.userId);
      await writeAudit(c, {
        action: 'password_change',
        entity: 'user',
        entityId: actor.userId,
        ip: client.ip,
      });
    });
  }

  /**
   * Owner-only: set another user's password directly, from Users & access (for staff without
   * email, or when mail is down). Same policy as everywhere (length, breach list, not the name or
   * email); the user is signed out everywhere, unlocked, and any open invite or reset link stops
   * working. Audited. The owner's own password goes through changePassword (current password
   * required); a company has only one owner (app_user_one_owner).
   */
  async setPasswordFor(
    actor: Actor,
    userId: string,
    newPassword: string,
    client: ClientInfo,
  ): Promise<void> {
    if (actor.role !== 'owner' || !actor.active) {
      throw new DomainError('FORBIDDEN', 'Only the owner can set passwords.');
    }
    assertId(userId, 'User');
    if (userId === actor.userId) {
      throw new DomainError(
        'VALIDATION',
        'Change your own password with your current password.',
        'password',
      );
    }
    const ctx = { companyId: actor.companyId, userId: actor.userId };
    const target = await withTenant(this.deps.pool, ctx, async (c) => {
      const { rows } = await c.query<{ email: string; name: string }>(
        'SELECT email, name FROM app_user WHERE id = $1',
        [userId],
      );
      return rows[0];
    });
    if (!target) throw new DomainError('NOT_FOUND', 'User not found.');
    await assertPasswordPolicy(newPassword, target, this.deps.breach);
    const newHash = await hashPassword(newPassword);
    await withTenant(this.deps.pool, ctx, async (c) => {
      await c.query(
        `UPDATE app_user SET password_hash = $2, password_changed_at = now(), failed_attempts = 0,
                locked_until = NULL
          WHERE id = $1`,
        [userId, newHash],
      );
      await c.query(
        'UPDATE auth_token SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
        [userId],
      );
      await revokeUserSessions(c, userId);
      await writeAudit(c, {
        action: 'password_set_by_owner',
        entity: 'user',
        entityId: userId,
        ip: client.ip,
      });
    });
  }

  private async checkCurrentPassword(
    c: pg.PoolClient,
    userId: string,
    password: string,
  ): Promise<
    | { ok: true; user: { email: string; name: string; password_hash: string } }
    | { ok: false; failed: boolean; locked: boolean }
  > {
    const { rows } = await c.query<{
      email: string;
      name: string;
      password_hash: string | null;
      locked: boolean;
    }>(
      `SELECT email, name, password_hash, coalesce(locked_until > now(), false) AS locked
         FROM app_user WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const u = rows[0];
    if (!u || u.locked) return { ok: false, failed: false, locked: false };
    if (u.password_hash && (await verifyPassword(u.password_hash, password))) {
      await c.query('UPDATE app_user SET failed_attempts = 0 WHERE id = $1', [userId]);
      return { ok: true, user: { ...u, password_hash: u.password_hash } };
    }
    const failure = await c.query<{ locked: boolean }>('SELECT auth_record_failure($1) AS locked', [
      userId,
    ]);
    return { ok: false, failed: true, locked: failure.rows[0]?.locked ?? false };
  }

  /**
   * Creates a single-use 24-hour token (invalidating older ones of the same purpose) and
   * returns the email to send. Callers send it AFTER their transaction commits.
   */
  async issueToken(
    c: pg.PoolClient,
    userId: string,
    purpose: 'invite' | 'reset',
  ): Promise<MailMessage> {
    const { rows } = await c.query<{ email: string; name: string }>(
      'SELECT email, name FROM app_user WHERE id = $1',
      [userId],
    );
    const u = rows[0];
    if (!u) throw new DomainError('NOT_FOUND', 'User not found.');
    await c.query(
      `UPDATE auth_token SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
      [userId, purpose],
    );
    const token = randomToken();
    await c.query(
      `INSERT INTO auth_token (company_id, user_id, purpose, token_hash, expires_at)
       VALUES (app_company_id(), $1, $2, $3, now() + interval '24 hours')`,
      [userId, purpose, sha256(token)],
    );
    const path = purpose === 'invite' ? 'accept-invite' : 'reset-password';
    return {
      to: u.email,
      subject:
        purpose === 'invite'
          ? 'You have been invited to Cityscape Books'
          : 'Reset your Cityscape Books password',
      text:
        `Hello ${u.name},\n\nOpen this link within 24 hours:\n${this.deps.config.appUrl}/${path}?token=${token}\n\n` +
        'If you did not expect this email, ignore it.',
    };
  }

  /** "Forgot password": same outward result whether or not the account exists. */
  async requestPasswordReset(email: string): Promise<void> {
    const found = await this.deps.pool.query<{
      id: string;
      company_id: string;
      is_active: boolean;
    }>('SELECT id, company_id, is_active FROM auth_find_user($1)', [email.trim()]);
    const user = found.rows[0];
    if (!user?.is_active) return;
    const mail = await withTenant(
      this.deps.pool,
      { companyId: user.company_id, userId: user.id },
      async (c) => {
        const m = await this.issueToken(c, user.id, 'reset');
        await writeAudit(c, {
          action: 'password_reset_requested',
          entity: 'user',
          entityId: user.id,
        });
        return m;
      },
    );
    // Fire-and-forget: a slow or failing provider must not reveal that the account exists.
    this.sendAfterCommit([mail]);
  }

  /**
   * Accepts an invite or reset link. The password is validated before the token is consumed,
   * and consuming happens in the same transaction as setting the password.
   */
  async redeemToken(
    token: string,
    purpose: 'invite' | 'reset',
    newPassword: string,
  ): Promise<void> {
    const { pool, breach } = this.deps;
    const hash = sha256(token);
    const peek = await pool.query<{
      user_id: string;
      company_id: string;
      email: string;
      name: string;
    }>('SELECT * FROM auth_peek_token($1, $2)', [hash, purpose]);
    const t = peek.rows[0];
    if (!t)
      throw new DomainError('VALIDATION', 'This link has expired or was already used.', 'token');
    await assertPasswordPolicy(newPassword, t, breach);
    const newHash = await hashPassword(newPassword);
    await withTenant(pool, { companyId: t.company_id, userId: t.user_id }, async (c) => {
      const consumed = await c.query('SELECT * FROM auth_consume_token($1, $2)', [hash, purpose]);
      if (consumed.rowCount !== 1) {
        throw new DomainError('VALIDATION', 'This link has expired or was already used.', 'token');
      }
      await c.query(
        `UPDATE app_user SET password_hash = $2, password_changed_at = now(), failed_attempts = 0, locked_until = NULL
          WHERE id = $1`,
        [t.user_id, newHash],
      );
      await revokeUserSessions(c, t.user_id);
      await writeAudit(c, {
        action: purpose === 'invite' ? 'invite_accepted' : 'password_reset',
        entity: 'user',
        entityId: t.user_id,
      });
    });
  }

  /** Sends mails after the transaction that produced them has committed. Never throws. */
  sendAfterCommit(mails: readonly MailMessage[]): void {
    for (const mail of mails) {
      this.deps.mailer
        .send(mail)
        .catch((error: unknown) => this.deps.onMailError?.(error, mail.subject));
    }
  }

  /**
   * One attempt per user at a time: the user row stays locked from lookup to recording the
   * outcome, so concurrent guesses can never get past the 5-failure limit.
   */
  private async attempt(email: string, password: string): Promise<Attempt> {
    const conn = await this.deps.pool.connect();
    let broken: Error | undefined;
    try {
      await conn.query('BEGIN');
      const user = (await conn.query<AttemptRow>('SELECT * FROM auth_begin_attempt($1)', [email]))
        .rows[0];
      const result = await this.judge(conn, user, password);
      await conn.query('COMMIT');
      return result;
    } catch (error) {
      await conn.query('ROLLBACK').catch((e: unknown) => {
        broken = e instanceof Error ? e : new Error(String(e));
      });
      throw mapDbError(error);
    } finally {
      conn.release(broken);
    }
  }

  private async judge(
    conn: pg.PoolClient,
    user: AttemptRow | undefined,
    password: string,
  ): Promise<Attempt> {
    if (!user?.password_hash || user.locked) {
      await dummyVerify(password); // same cost as a real check: no timing signal
      return { kind: 'fail', user, justLocked: false, denied: user !== undefined };
    }
    if (!(await verifyPassword(user.password_hash, password))) {
      const { rows } = await conn.query<{ locked: boolean }>(
        'SELECT auth_record_failure($1) AS locked',
        [user.id],
      );
      return { kind: 'fail', user, justLocked: rows[0]?.locked ?? false, denied: false };
    }
    const usable = isUsable(user);
    if (!usable) return { kind: 'fail', user, justLocked: false, denied: true };
    const { rows } = await conn.query<{ ok: boolean }>('SELECT auth_record_success($1) AS ok', [
      user.id,
    ]);
    return rows[0]?.ok
      ? { kind: 'ok', user }
      : { kind: 'fail', user, justLocked: false, denied: true };
  }

  private async recordFailedAttempt(
    attempt: Extract<Attempt, { kind: 'fail' }>,
    client: ClientInfo,
  ): Promise<void> {
    if (!attempt.user) return;
    const ctx = ctxOf(attempt.user);
    if (attempt.justLocked) {
      await this.afterFailure(ctx, true, 'login', client);
      return;
    }
    await writeAuditDetached(this.deps.pool, ctx, {
      action: 'login',
      entity: 'user',
      entityId: ctx.userId,
      outcome: attempt.denied ? 'denied' : 'failed',
      ip: client.ip,
    });
  }

  /** A failure that triggered the lockout notifies the owner (in-app + email); others are audited. */
  private async afterFailure(
    ctx: TenantContext,
    justLocked: boolean,
    action: string,
    client: ClientInfo,
  ): Promise<void> {
    const { pool } = this.deps;
    if (!justLocked) {
      await writeAuditDetached(pool, ctx, {
        action,
        entity: 'user',
        entityId: ctx.userId,
        outcome: 'failed',
        ip: client.ip,
      });
      return;
    }
    await pool.query('SELECT auth_notify_owner_lockout($1, $2)', [ctx.userId, client.ip]);
    const owner = await withTenant(pool, ctx, async (c) => {
      const { rows } = await c.query<{ owner: string; name: string; email: string }>(
        `SELECT o.email AS owner, u.name, u.email FROM app_user u JOIN app_user o ON o.role = 'owner' WHERE u.id = $1`,
        [ctx.userId],
      );
      return rows[0];
    });
    if (owner) {
      this.sendAfterCommit([
        {
          to: owner.owner,
          subject: 'Cityscape Books: account locked',
          text:
            `${owner.name} (${owner.email}) was locked for 15 minutes after 5 failed sign-ins` +
            `${client.ip ? ` from ${client.ip}` : ''}. If this was not them, reset their password.`,
        },
      ]);
    }
  }

  private async handleUnknownRefresh(hash: string, client: ClientInfo): Promise<never> {
    const { rows } = await this.deps.pool.query<{
      verdict: 'race' | 'reuse';
      user_id: string;
      company_id: string;
    }>('SELECT * FROM auth_detect_reuse($1)', [hash]);
    const hit = rows[0];
    if (hit?.verdict === 'race') throw raceError();
    if (hit?.verdict === 'reuse') {
      await writeAuditDetached(
        this.deps.pool,
        { companyId: hit.company_id, userId: hit.user_id },
        {
          action: 'refresh_token_reuse',
          entity: 'session',
          outcome: 'denied',
          ip: client.ip,
        },
      );
    }
    throw unauth();
  }

  private isIdle(lastSeen: Date): boolean {
    return Date.now() - lastSeen.getTime() > this.idleTimeout * 1000;
  }

  private async revokeSession(ctx: TenantContext, sessionId: string): Promise<void> {
    await withTenant(this.deps.pool, ctx, (c) =>
      c.query('UPDATE session SET revoked_at = now() WHERE id = $1', [sessionId]),
    );
  }

  private async createSession(
    c: pg.PoolClient,
    userId: string,
    companyId: string,
    client: ClientInfo,
  ): Promise<Tokens> {
    const refreshToken = randomToken();
    const expires = new Date(Date.now() + this.refreshTtl * 1000);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO session (company_id, user_id, refresh_token_hash, ip, user_agent, device_id, expires_at)
       VALUES (app_company_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, sha256(refreshToken), client.ip, client.userAgent, client.deviceId ?? null, expires],
    );
    const sessionId = rows[0]?.id;
    if (!sessionId) throw new Error('session insert returned no id');
    return {
      accessToken: await this.signAccess({ userId, companyId, sessionId }),
      refreshToken,
      refreshExpiresAt: expires,
    };
  }

  private signAccess(claims: AccessClaims): Promise<string> {
    return new SignJWT({ cid: claims.companyId, sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtl}s`)
      .sign(this.deps.config.jwtSecret);
  }

  private async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.deps.config.jwtSecret, {
        issuer: ISSUER,
        algorithms: ['HS256'],
      });
      return {
        userId: String(payload.sub),
        companyId: String(payload['cid']),
        sessionId: String(payload['sid']),
      };
    } catch {
      throw unauth();
    }
  }

  /**
   * H1 compensating control: an Owner/Admin sign-in from a new device OR a new IP notifies the
   * owner in-app and by email. The first ever sign-in is not alerted.
   */
  private async newDeviceAlert(
    c: pg.PoolClient,
    user: AttemptRow,
    client: ClientInfo,
  ): Promise<MailMessage[]> {
    const label = ROLE_LABEL[user.role];
    if (!label) return [];
    const { rows } = await c.query<{
      any_session: boolean;
      known_ip: boolean;
      known_device: boolean;
    }>(
      `SELECT EXISTS (SELECT 1 FROM session WHERE user_id = $1) AS any_session,
              EXISTS (SELECT 1 FROM session WHERE user_id = $1 AND ip = $2) AS known_ip,
              EXISTS (SELECT 1 FROM session WHERE user_id = $1 AND device_id = $3) AS known_device`,
      [user.id, client.ip, client.deviceId ?? null],
    );
    const where = describeNewSignIn(rows[0], client);
    if (!where) return [];
    const body = `The ${label} account (${user.name}) signed in from ${where}.`;
    const owner = await c.query<{ id: string; email: string }>(
      `INSERT INTO notification (company_id, user_id, key, type, title, body, link)
       SELECT app_company_id(), o.id, 'newdevice:' || $1 || ':' || md5($2), 'security', 'New sign-in', $3, '/settings/audit'
         FROM app_user o WHERE o.role = 'owner'
       ON CONFLICT (user_id, key) DO NOTHING
       RETURNING (SELECT email FROM app_user WHERE role = 'owner') AS email, user_id AS id`,
      [user.id, `${client.ip ?? ''}|${client.deviceId ?? ''}|${Date.now()}`, body],
    );
    const to = owner.rows[0]?.email;
    return to
      ? [
          {
            to,
            subject: 'Cityscape Books: new sign-in',
            text: `${body} If this was not expected, change the password now.`,
          },
        ]
      : [];
  }
}

function isUsable(user: AttemptRow): boolean {
  const notExpired =
    user.access_expires_at === null || user.access_expires_at.getTime() > Date.now();
  return user.is_active && notExpired;
}

/** "a new device and a new address (…)" — or null when the sign-in is from a known place, or the first ever. */
function describeNewSignIn(
  seen: { any_session: boolean; known_ip: boolean; known_device: boolean } | undefined,
  client: ClientInfo,
): string | null {
  if (!seen?.any_session) return null;
  const parts: string[] = [];
  if (!client.deviceId || !seen.known_device) parts.push('a new device');
  if (client.ip !== null && !seen.known_ip) parts.push(`a new address (${client.ip})`);
  return parts.length > 0 ? parts.join(' and ') : null;
}

const ctxOf = (u: { id: string; company_id: string }): TenantContext => ({
  companyId: u.company_id,
  userId: u.id,
});

const raceError = (): DomainError =>
  new DomainError('CONFLICT', 'Your session was refreshed in another tab. Retry the request.');

export async function revokeUserSessions(c: pg.PoolClient, userId: string): Promise<void> {
  await c.query('UPDATE session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
    userId,
  ]);
}
