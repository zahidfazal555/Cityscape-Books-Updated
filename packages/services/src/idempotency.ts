import { createHash } from 'node:crypto';
import { DomainError, type Actor } from '@csd/core';
import { withTenant } from '@csd/db';
import type pg from 'pg';
import { tenantOf } from './validation.js';

export type IdempotencyStart =
  { kind: 'fresh' } | { kind: 'replay'; status: number; body: unknown };

const KEY = /^[A-Za-z0-9_-]{16,100}$/;

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method} ${path}\n${JSON.stringify(body ?? null)}`)
    .digest('hex');
}

/**
 * Replay protection (ENGINEERING-STANDARDS §4): the first request with a key runs; a repeat with
 * the same key and body returns the stored response; the same key with a different body is
 * refused. Keys expire after 24 hours.
 */
export class IdempotencyService {
  constructor(private readonly pool: pg.Pool) {}

  async begin(
    actor: Actor,
    key: string,
    method: string,
    path: string,
    body: unknown,
  ): Promise<IdempotencyStart> {
    if (!KEY.test(key))
      throw new DomainError(
        'VALIDATION',
        'Idempotency-Key must be 16–100 letters, digits, - or _.',
      );
    const hash = requestHash(method, path, body);
    return withTenant(this.pool, tenantOf(actor), async (c) => {
      await c.query(
        `DELETE FROM idempotency_key WHERE user_id = $1 AND key = $2 AND created_at < now() - interval '24 hours'`,
        [actor.userId, key],
      );
      const inserted = await c.query(
        `INSERT INTO idempotency_key (company_id, user_id, key, method, path, request_hash)
         VALUES (app_company_id(), $1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [actor.userId, key, method, path, hash],
      );
      if (inserted.rowCount === 1) return { kind: 'fresh' };
      const { rows } = await c.query<{
        request_hash: string;
        status: number | null;
        body: unknown;
      }>('SELECT request_hash, status, body FROM idempotency_key WHERE user_id = $1 AND key = $2', [
        actor.userId,
        key,
      ]);
      const prior = rows[0];
      if (!prior) return { kind: 'fresh' };
      if (prior.request_hash !== hash) {
        throw new DomainError(
          'VALIDATION',
          'This Idempotency-Key was already used for a different request.',
        );
      }
      if (prior.status === null)
        throw new DomainError('CONFLICT', 'The same request is still being processed.');
      return { kind: 'replay', status: prior.status, body: prior.body };
    });
  }

  /**
   * Stores a successful outcome for replay. Any error (4xx or 5xx) changed nothing, so the key is
   * released: the user can correct the form and submit again with the same key.
   */
  async finish(actor: Actor, key: string, status: number, body: unknown): Promise<void> {
    await withTenant(this.pool, tenantOf(actor), async (c) => {
      if (status >= 400) {
        await c.query('DELETE FROM idempotency_key WHERE user_id = $1 AND key = $2', [
          actor.userId,
          key,
        ]);
        return;
      }
      await c.query(
        'UPDATE idempotency_key SET status = $3, body = $4 WHERE user_id = $1 AND key = $2',
        [actor.userId, key, status, body === undefined ? null : JSON.stringify(body)],
      );
    });
  }
}
