import { mapPlainDeep } from '@csd/core';
import type pg from 'pg';
import { withTenant, type TenantContext } from './tx.js';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  outcome?: 'success' | 'denied' | 'failed';
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

const SECRET_KEYS = /pass(word)?|token|secret|hash|authorization|cookie/i;

/** Removes secrets from audit snapshots (ENGINEERING-STANDARDS §2 logging). */
export function redact(value: unknown): unknown {
  return mapPlainDeep(value, (k, v) => [k, SECRET_KEYS.test(k) ? '[redacted]' : v]);
}

/** Appends an audit row in the caller's transaction; company and user come from the context. */
export async function writeAudit(client: pg.PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (company_id, user_id, ip, action, entity, entity_id, outcome, before, after)
     VALUES (app_company_id(), app_user_id(), $1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.ip ?? null,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      entry.outcome ?? 'success',
      entry.before === undefined ? null : JSON.stringify(redact(entry.before)),
      entry.after === undefined ? null : JSON.stringify(redact(entry.after)),
    ],
  );
}

/**
 * Writes an audit row in its OWN transaction, so it survives when the caller's transaction
 * rolls back. Use it for `denied` and `failed` outcomes (handbook §7.3, security alerts).
 */
export async function writeAuditDetached(
  pool: pg.Pool,
  ctx: TenantContext,
  entry: AuditEntry,
): Promise<void> {
  await withTenant(pool, ctx, (client) => writeAudit(client, entry));
}
