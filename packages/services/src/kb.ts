import { DomainError, assertId, authorize, type Actor } from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { parse, tenantOf as ctx } from './validation.js';

export const KB_CATEGORIES = ['care', 'warranty', 'howto', 'checklist'] as const;
export type KbCategory = (typeof KB_CATEGORIES)[number];

const articleSchema = z.object({
  title: z.string().trim().min(1, 'Enter the title.').max(200),
  category: z.enum(KB_CATEGORIES),
  body: z.string().trim().min(1, 'Write the guide.').max(20_000),
});
const templateSchema = z.object({
  title: z.string().trim().min(1, 'Enter the name.').max(120),
  body: z.string().trim().min(1, 'Write the message.').max(4000),
});

export interface KbArticle {
  id: string;
  title: string;
  category: KbCategory;
  body: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ReplyTemplate {
  id: string;
  title: string;
  body: string;
}

type Kind = 'article' | 'template';
const TABLE = { article: 'kb_article', template: 'reply_template' } as const;

/**
 * Knowledge base (Req §4.21): care guides and reply templates, both insertable into ticket
 * replies. `kb ≥ edit` creates and edits; `kb = full` deletes (soft).
 */
export class KnowledgeBaseService {
  constructor(private readonly pool: pg.Pool) {}

  async articles(actor: Actor): Promise<KbArticle[]> {
    authorize(actor, 'kb', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<{
        id: string;
        title: string;
        category: KbCategory;
        body: string;
        updated_at: Date;
        updated_by: string | null;
      }>(
        `SELECT a.id, a.title, a.category, a.body, a.updated_at, u.name AS updated_by
           FROM kb_article a LEFT JOIN app_user u ON u.id = a.updated_by
          WHERE a.deleted_at IS NULL ORDER BY a.category, a.title`,
      );
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category,
        body: r.body,
        updatedAt: r.updated_at.toISOString(),
        updatedBy: r.updated_by,
      }));
    });
  }

  /** Reply templates: anyone who handles tickets may read them to insert into a reply. */
  async templates(actor: Actor): Promise<ReplyTemplate[]> {
    authorize(actor, 'kb', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<ReplyTemplate>(
        `SELECT id, title, body FROM reply_template WHERE deleted_at IS NULL ORDER BY title`,
      );
      return rows;
    });
  }

  async saveArticle(
    actor: Actor,
    id: string | null,
    input: z.input<typeof articleSchema>,
  ): Promise<{ id: string }> {
    const data = parse(articleSchema, input);
    return this.save(actor, 'article', id, data, [data.title, data.category, data.body]);
  }

  async saveTemplate(
    actor: Actor,
    id: string | null,
    input: z.input<typeof templateSchema>,
  ): Promise<{ id: string }> {
    const data = parse(templateSchema, input);
    return this.save(actor, 'template', id, data, [data.title, data.body]);
  }

  async remove(actor: Actor, kind: Kind, id: string): Promise<void> {
    assertId(id, kind === 'article' ? 'Guide' : 'Template');
    authorize(actor, 'kb', 'full');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const r = await c.query(
        `UPDATE ${TABLE[kind]} SET deleted_at = now(), updated_by = app_user_id() WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (r.rowCount === 0) throw new DomainError('NOT_FOUND', 'Not found.');
      await writeAudit(c, { action: 'delete', entity: TABLE[kind], entityId: id });
    });
  }

  private async save(
    actor: Actor,
    kind: Kind,
    id: string | null,
    data: object,
    values: string[],
  ): Promise<{ id: string }> {
    authorize(actor, 'kb', 'edit');
    if (id) assertId(id, 'Entry');
    const cols = kind === 'article' ? ['title', 'category', 'body'] : ['title', 'body'];
    return withTenant(this.pool, ctx(actor), async (c) => {
      const sql = id
        ? `UPDATE ${TABLE[kind]} SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(', ')}, updated_by = app_user_id()
            WHERE id = $1 AND deleted_at IS NULL RETURNING id`
        : `INSERT INTO ${TABLE[kind]} (company_id, ${cols.join(', ')}, created_by, updated_by)
           VALUES (app_company_id(), ${cols.map((_c, i) => `$${i + 1}`).join(', ')}, app_user_id(), app_user_id())
           RETURNING id`;
      const { rows } = await c.query<{ id: string }>(sql, id ? [id, ...values] : values);
      const saved = rows[0]?.id;
      if (!saved) throw new DomainError('NOT_FOUND', 'Not found.');
      await writeAudit(c, {
        action: id ? 'update' : 'create',
        entity: TABLE[kind],
        entityId: saved,
        after: data,
      });
      return { id: saved };
    });
  }
}
