import { DomainError } from '@csd/core';
import type pg from 'pg';

export interface TenantContext {
  companyId: string;
  userId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maps our custom SQLSTATEs and common constraint errors to DomainError. */
export function mapDbError(error: unknown): unknown {
  const e = error as { code?: string; message?: string; constraint?: string };
  switch (e.code) {
    case 'CB423':
      return new DomainError('PERIOD_LOCKED', e.message ?? 'Books are locked.', 'date');
    case 'CB422':
      return new DomainError('VALIDATION', 'Journal does not balance.');
    case 'CB409':
      return new DomainError('CONFLICT', 'This record cannot be changed.');
    case '23505':
      return new DomainError('CONFLICT', 'A record with these details already exists.');
    case '42501':
      return new DomainError('FORBIDDEN', 'You do not have access to this.');
    default:
      return error;
  }
}

/**
 * Runs `fn` in one transaction with the tenant context set via SET LOCAL, so RLS binds every
 * statement to the caller's company. The company always comes from the authenticated session.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  ctx: TenantContext,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(ctx.companyId) || (ctx.userId !== null && !UUID.test(ctx.userId))) {
    throw new DomainError('FORBIDDEN', 'Invalid session.');
  }
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.company_id', $1, true), set_config('app.user_id', $2, true)`,
      [ctx.companyId, ctx.userId ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      // A failed ROLLBACK means the connection is unusable: destroy it, don't pool it.
      broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    });
    throw mapDbError(error);
  } finally {
    client.release(broken);
  }
}
