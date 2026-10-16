import { DomainError, type Actor } from '@csd/core';
import { withTenant, writeAudit, writeAuditDetached } from '@csd/db';
import { SignJWT, jwtVerify } from 'jose';
import type pg from 'pg';
import { loadActor } from './actor.js';
import { randomToken, sha256 } from './crypto.js';
import type { Mailer } from './mailer.js';
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
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
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

const BAD_LOGIN = 'Email or password is incorrect.';
const ISSUER = 'cityscape-books';

interface FoundUser {
  id: string;
  company_id: string;
  password_hash: string | null;
  role: string;
  is_active: boolean;
  access_expires_at: Date | null;
  locked_until: Date | null;
}

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

  /** Email + password, single step. Generic error for unknown, wrong or inactive accounts. */
  async login(email: string, password: string, client: ClientInfo): Promise<Tokens> {
    const { pool } = this.deps;
    const found = await pool.query<FoundUser>('SELECT * FROM auth_find_user($1)', [email.trim()]);
    const user = found.rows[0];
    if (!user?.password_hash) {
      await dummyVerify(password);
      throw new DomainError('UNAUTHENTICATED', BAD_LOGIN);
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      throw new DomainError(
        'UNAUTHENTICATED',
        'Too many failed sign-ins. Try again in 15 minutes.',
      );
    }
    const ok = await verifyPassword(user.password_hash, password);
    const usable =
      user.is_active &&
      (user.access_expires_at === null || user.access_expires_at.getTime() > Date.now());
    if (!ok || !usable) {
      if (!ok) await this.recordFailure(user);
      else await this.audit(user, 'login', 'denied', client);
      throw new DomainError('UNAUTHENTICATED', BAD_LOGIN);
    }
    return withTenant(pool, { companyId: user.company_id, userId: user.id }, async (c) => {
      await c.query(
        'UPDATE app_user SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
        [user.id],
      );
      await this.notifyNewDevice(c, user, client);
      await writeAudit(c, { action: 'login', entity: 'user', entityId: user.id, ip: client.ip });
      return this.createSession(c, user.id, user.company_id, client);
    });
  }

  /** Rotates the refresh token. 30 min without a refresh ends the session (idle timeout). */
  async refresh(refreshToken: string, client: ClientInfo): Promise<Tokens> {
    const { pool } = this.deps;
    const hash = sha256(refreshToken);
    const found = await pool.query<{
      id: string;
      company_id: string;
      user_id: string;
      last_seen_at: Date;
    }>('SELECT id, company_id, user_id, last_seen_at FROM auth_find_session($1)', [hash]);
    const session = found.rows[0];
    if (!session) {
      const reused = await pool.query<{ user_id: string; company_id: string }>(
        'SELECT * FROM auth_detect_reuse($1)',
        [hash],
      );
      const victim = reused.rows[0];
      if (victim) {
        await writeAuditDetached(
          pool,
          { companyId: victim.company_id, userId: victim.user_id },
          {
            action: 'refresh_token_reuse',
            entity: 'session',
            outcome: 'denied',
            ip: client.ip,
          },
        );
      }
      throw new DomainError('UNAUTHENTICATED', 'Please sign in again.');
    }
    const ctx = { companyId: session.company_id, userId: session.user_id };
    if (Date.now() - session.last_seen_at.getTime() > this.idleTimeout * 1000) {
      await withTenant(pool, ctx, (c) =>
        c.query('UPDATE session SET revoked_at = now() WHERE id = $1', [session.id]),
      );
      throw new DomainError(
        'UNAUTHENTICATED',
        'Your session ended after 30 minutes idle. Please sign in again.',
      );
    }
    return withTenant(pool, ctx, async (c) => {
      const actor = await loadActor(c, session.user_id);
      if (!actor.active) {
        await c.query('UPDATE session SET revoked_at = now() WHERE id = $1', [session.id]);
        throw new DomainError('UNAUTHENTICATED', 'Please sign in again.');
      }
      const next = randomToken();
      const expires = new Date(Date.now() + this.refreshTtl * 1000);
      const updated = await c.query(
        `UPDATE session SET previous_token_hash = refresh_token_hash, refresh_token_hash = $2,
                last_seen_at = now(), expires_at = $3, ip = $4, user_agent = $5
          WHERE id = $1 AND refresh_token_hash = $6 AND revoked_at IS NULL`,
        [session.id, sha256(next), expires, client.ip, client.userAgent, hash],
      );
      // A concurrent refresh already rotated this token.
      if (updated.rowCount !== 1) throw new DomainError('UNAUTHENTICATED', 'Please sign in again.');
      return {
        accessToken: await this.signAccess({ ...ctx, sessionId: session.id }),
        refreshToken: next,
        refreshExpiresAt: expires,
      };
    });
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

  /** Verifies a 15-minute access token and confirms its session is still live. */
  async authenticate(accessToken: string): Promise<{ claims: AccessClaims; actor: Actor }> {
    let claims: AccessClaims;
    try {
      const { payload } = await jwtVerify(accessToken, this.deps.config.jwtSecret, {
        issuer: ISSUER,
        algorithms: ['HS256'],
      });
      claims = {
        userId: String(payload.sub),
        companyId: String(payload['cid']),
        sessionId: String(payload['sid']),
      };
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'Please sign in again.');
    }
    const actor = await withTenant(
      this.deps.pool,
      { companyId: claims.companyId, userId: claims.userId },
      async (c) => {
        const live = await c.query(
          'SELECT 1 FROM session WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()',
          [claims.sessionId, claims.userId],
        );
        if (live.rowCount !== 1) throw new DomainError('UNAUTHENTICATED', 'Please sign in again.');
        return loadActor(c, claims.userId);
      },
    );
    if (!actor.active) throw new DomainError('UNAUTHENTICATED', 'Please sign in again.');
    return { claims, actor };
  }

  /** Changing a password signs the user out everywhere. */
  async changePassword(actor: Actor, currentPassword: string, newPassword: string): Promise<void> {
    await withTenant(
      this.deps.pool,
      { companyId: actor.companyId, userId: actor.userId },
      async (c) => {
        const { rows } = await c.query<{
          email: string;
          name: string;
          password_hash: string | null;
        }>('SELECT email, name, password_hash FROM app_user WHERE id = $1', [actor.userId]);
        const u = rows[0];
        if (!u?.password_hash || !(await verifyPassword(u.password_hash, currentPassword))) {
          throw new DomainError('VALIDATION', 'Current password is incorrect.', 'currentPassword');
        }
        await assertPasswordPolicy(newPassword, u, this.deps.breach);
        await this.setPassword(c, actor.userId, newPassword);
        await writeAudit(c, { action: 'password_change', entity: 'user', entityId: actor.userId });
      },
    );
  }

  /** Emails a single-use 24-hour link. Called by the users service and by "Forgot password". */
  async issueToken(c: pg.PoolClient, userId: string, purpose: 'invite' | 'reset'): Promise<void> {
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
    await this.deps.mailer.send({
      to: u.email,
      subject:
        purpose === 'invite'
          ? 'You have been invited to Cityscape Books'
          : 'Reset your Cityscape Books password',
      text:
        `Hello ${u.name},\n\nOpen this link within 24 hours:\n${this.deps.config.appUrl}/${path}?token=${token}\n\n` +
        'If you did not expect this email, ignore it.',
    });
  }

  /** "Forgot password": always succeeds outwardly, so it cannot be used to find accounts. */
  async requestPasswordReset(email: string): Promise<void> {
    const found = await this.deps.pool.query<FoundUser>('SELECT * FROM auth_find_user($1)', [
      email.trim(),
    ]);
    const user = found.rows[0];
    if (!user?.is_active) return;
    await withTenant(this.deps.pool, { companyId: user.company_id, userId: user.id }, async (c) => {
      await this.issueToken(c, user.id, 'reset');
      await writeAudit(c, {
        action: 'password_reset_requested',
        entity: 'user',
        entityId: user.id,
      });
    });
  }

  /** Accepts an invite or a reset link: sets the password and revokes every other session. */
  async redeemToken(
    token: string,
    purpose: 'invite' | 'reset',
    newPassword: string,
  ): Promise<void> {
    const { pool, breach } = this.deps;
    const consumed = await pool.query<{ user_id: string; company_id: string }>(
      'SELECT * FROM auth_consume_token($1, $2)',
      [sha256(token), purpose],
    );
    const t = consumed.rows[0];
    if (!t)
      throw new DomainError('VALIDATION', 'This link has expired or was already used.', 'token');
    await withTenant(pool, { companyId: t.company_id, userId: t.user_id }, async (c) => {
      const { rows } = await c.query<{ email: string; name: string }>(
        'SELECT email, name FROM app_user WHERE id = $1',
        [t.user_id],
      );
      await assertPasswordPolicy(newPassword, rows[0] ?? { email: '', name: '' }, breach);
      await this.setPassword(c, t.user_id, newPassword);
      await writeAudit(c, {
        action: purpose === 'invite' ? 'invite_accepted' : 'password_reset',
        entity: 'user',
        entityId: t.user_id,
      });
    });
  }

  private async setPassword(c: pg.PoolClient, userId: string, password: string): Promise<void> {
    await c.query(
      `UPDATE app_user SET password_hash = $2, password_changed_at = now(), failed_attempts = 0, locked_until = NULL
        WHERE id = $1`,
      [userId, await hashPassword(password)],
    );
    await c.query(
      'UPDATE session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
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
      `INSERT INTO session (company_id, user_id, refresh_token_hash, ip, user_agent, expires_at)
       VALUES (app_company_id(), $1, $2, $3, $4, $5) RETURNING id`,
      [userId, sha256(refreshToken), client.ip, client.userAgent, expires],
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

  private async recordFailure(user: FoundUser): Promise<void> {
    const { rows } = await this.deps.pool.query<{ t: Date | null }>(
      'SELECT auth_record_failure($1) AS t',
      [user.id],
    );
    const lockedNow = rows[0]?.t && rows[0].t.getTime() > Date.now() + 14 * 60_000;
    if (lockedNow) await this.deps.pool.query('SELECT auth_notify_owner_lockout($1)', [user.id]);
    else await this.audit(user, 'login', 'failed', { ip: null, userAgent: null });
  }

  private audit(
    user: FoundUser,
    action: string,
    outcome: 'denied' | 'failed',
    client: ClientInfo,
  ): Promise<void> {
    return writeAuditDetached(
      this.deps.pool,
      { companyId: user.company_id, userId: user.id },
      {
        action,
        entity: 'user',
        entityId: user.id,
        outcome,
        ip: client.ip,
      },
    );
  }

  /** H1 compensating control: tell the owner when the Owner or Admin signs in from a new IP. */
  private async notifyNewDevice(
    c: pg.PoolClient,
    user: FoundUser,
    client: ClientInfo,
  ): Promise<void> {
    if ((user.role !== 'owner' && user.role !== 'admin') || client.ip === null) return;
    const seen = await c.query('SELECT 1 FROM session WHERE user_id = $1 AND ip = $2 LIMIT 1', [
      user.id,
      client.ip,
    ]);
    const first = await c.query('SELECT 1 FROM session WHERE user_id = $1 LIMIT 1', [user.id]);
    if (seen.rowCount === 1 || first.rowCount === 0) return;
    await c.query(
      `INSERT INTO notification (company_id, user_id, key, type, title, body, link)
       SELECT app_company_id(), o.id, 'newdevice:' || $1 || ':' || $2, 'security',
              'New sign-in location', $3, '/settings/audit'
         FROM app_user o WHERE o.role = 'owner'
       ON CONFLICT (user_id, key) DO NOTHING`,
      [user.id, client.ip, `A ${user.role} account signed in from a new address (${client.ip}).`],
    );
  }
}
