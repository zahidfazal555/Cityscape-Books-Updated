import { DomainError, can, type Actor } from '@csd/core';
import { withTenant } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { notifySla } from './tickets.js';
import { parse, tenantOf as ctx } from './validation.js';

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  read: boolean;
}

const readSchema = z.object({ ids: z.array(z.string().uuid()).max(100).optional() });

/**
 * The signed-in user's own notifications (SLA alerts, new-device sign-ins). Reading them first
 * sweeps the SLA clocks, so alerts fire whenever anyone uses the app (BUG-160).
 */
export class NotificationsService {
  constructor(private readonly pool: pg.Pool) {}

  async mine(actor: Actor): Promise<{ unread: number; items: AppNotification[] }> {
    return withTenant(this.pool, ctx(actor), async (c) => {
      if (can(actor, 'tickets', 'view')) await notifySla(c);
      const { rows } = await c.query<{
        id: string;
        type: string;
        title: string;
        body: string | null;
        link: string | null;
        created_at: Date;
        read_at: Date | null;
        unread: string;
      }>(
        `SELECT id, type, title, body, link, created_at, read_at,
                (SELECT count(*) FROM notification WHERE user_id = app_user_id() AND read_at IS NULL)::text AS unread
           FROM notification WHERE user_id = app_user_id()
          ORDER BY read_at IS NULL DESC, created_at DESC LIMIT 20`,
      );
      return {
        unread: Number(rows[0]?.unread ?? 0),
        items: rows.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          body: r.body,
          link: r.link,
          createdAt: r.created_at.toISOString(),
          read: r.read_at !== null,
        })),
      };
    });
  }

  /** Marks the given notifications (or all) read; only the user's own. */
  async markRead(actor: Actor, input: z.input<typeof readSchema> = {}): Promise<void> {
    const data = parse(readSchema, input);
    await withTenant(this.pool, ctx(actor), async (c) => {
      const r = await c.query(
        `UPDATE notification SET read_at = now()
          WHERE user_id = app_user_id() AND read_at IS NULL AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))`,
        [data.ids ?? null],
      );
      if (data.ids && data.ids.length > 0 && r.rowCount === 0)
        throw new DomainError('NOT_FOUND', 'Notification not found.');
    });
  }
}
