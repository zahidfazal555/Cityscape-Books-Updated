import { DomainError, type Actor } from '@csd/core';
import { withTenant } from '@csd/db';
import type pg from 'pg';
import { tenantOf } from './validation.js';

export interface AuditEntry {
  id: number;
  at: Date;
  userId: string | null;
  userName: string | null;
  ip: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  outcome: 'success' | 'denied' | 'failed';
  before: unknown;
  after: unknown;
}

/** Audit trail viewer (Req §16): owner, and the auditor role (read-only by design). */
export class AuditService {
  constructor(private readonly pool: pg.Pool) {}

  /** Newest first, keyset-paginated by id. */
  async list(
    actor: Actor,
    opts: {
      beforeId?: number | undefined;
      limit?: number | undefined;
      entity?: string | undefined;
    } = {},
  ): Promise<AuditEntry[]> {
    if (!actor.active || (actor.role !== 'owner' && actor.role !== 'auditor')) {
      throw new DomainError('FORBIDDEN', 'Only the owner or the auditor can view the audit trail.');
    }
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
    return withTenant(this.pool, tenantOf(actor), async (c) => {
      const { rows } = await c.query<{
        id: string;
        at: Date;
        user_id: string | null;
        user_name: string | null;
        ip: string | null;
        action: string;
        entity: string;
        entity_id: string | null;
        outcome: AuditEntry['outcome'];
        before: unknown;
        after: unknown;
      }>(
        `SELECT a.id, a.at, a.user_id, u.name AS user_name, host(a.ip) AS ip, a.action, a.entity, a.entity_id,
                a.outcome, a.before, a.after
           FROM audit_log a LEFT JOIN app_user u ON u.id = a.user_id
          WHERE ($1::bigint IS NULL OR a.id < $1) AND ($2::text IS NULL OR a.entity = $2)
          ORDER BY a.id DESC LIMIT $3`,
        [opts.beforeId ?? null, opts.entity ?? null, limit],
      );
      return rows.map((r) => ({
        id: Number(r.id),
        at: r.at,
        userId: r.user_id,
        userName: r.user_name,
        ip: r.ip,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        outcome: r.outcome,
        before: r.before,
        after: r.after,
      }));
    });
  }
}
