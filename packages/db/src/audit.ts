import type pg from 'pg';

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
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? '[redacted]' : redact(v)]),
    );
  }
  return value;
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
