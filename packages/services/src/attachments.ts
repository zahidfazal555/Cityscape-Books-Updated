import { createHash, randomUUID } from 'node:crypto';
import { DomainError, assertId, authorize, can, canApprove, type Actor } from '@csd/core';
import { withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import type { BlobStore } from './blob-store.js';
import { MAX_UPLOAD_BYTES, cleanUpload, type AllowedType } from './files.js';
import { tenantOf as ctx } from './validation.js';

export interface StoredFile {
  bytes: Buffer;
  contentType: AllowedType;
}

/** Bill photos and receipts (Tech Spec §6 /attachments; H4: every view is audited). */
export class AttachmentsService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly store: BlobStore,
  ) {}

  /** Stores a JPEG, PNG or PDF (≤ 10 MB, type sniffed, photo metadata removed). */
  async upload(actor: Actor, raw: Buffer): Promise<{ id: string; contentType: AllowedType }> {
    authorize(actor, 'expenses', 'edit');
    if (raw.byteLength === 0) throw new DomainError('VALIDATION', 'The file is empty.', 'file');
    if (raw.byteLength > MAX_UPLOAD_BYTES)
      throw new DomainError('TOO_LARGE', 'The file is larger than 10 MB.');
    const clean = cleanUpload(raw);
    if (!clean)
      throw new DomainError('VALIDATION', 'Upload a photo (JPEG or PNG) or a PDF.', 'file');
    const id = randomUUID();
    const key = `${actor.companyId}/${id}`;
    // Row and file together: the file is written inside the transaction, so a failed insert
    // leaves no file and a failed write leaves no row (BUG-106).
    await withTenant(this.pool, ctx(actor), async (c) => {
      await assertUnclaimedQuota(c);
      await c.query(
        `INSERT INTO attachment (id, company_id, storage_key, thumbnail_key, content_type, size_bytes, sha256,
                                 uploaded_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, app_user_id())`,
        [
          id,
          key,
          clean.thumbnail ? `${key}.t` : null,
          clean.type,
          clean.bytes.byteLength,
          createHash('sha256').update(clean.bytes).digest('hex'),
        ],
      );
      await writeAudit(c, {
        action: 'upload',
        entity: 'attachment',
        entityId: id,
        after: { contentType: clean.type, size: clean.bytes.byteLength },
      });
      await this.store.put(key, clean.bytes);
      if (clean.thumbnail) await this.store.put(`${key}.t`, clean.thumbnail);
    });
    return { id, contentType: clean.type };
  }

  /**
   * Returns the file to someone who may see the expense it backs (or, before it is attached,
   * to its uploader). Every view writes an audit row (H4).
   */
  async read(actor: Actor, id: string): Promise<StoredFile> {
    assertId(id, 'File');
    const meta = await withTenant(this.pool, ctx(actor), async (c) => {
      const r = await visibleAttachment(c, actor, id);
      await writeAudit(c, { action: 'view', entity: 'attachment', entityId: id });
      return r;
    });
    return { bytes: await this.store.get(meta.storage_key), contentType: meta.content_type };
  }

  /**
   * The small card image (same access rule, not audited: it is a preview, not the bill).
   * PDFs have none.
   */
  async thumbnail(actor: Actor, id: string): Promise<StoredFile> {
    assertId(id, 'File');
    const meta = await withTenant(this.pool, ctx(actor), (c) => visibleAttachment(c, actor, id));
    if (!meta.thumbnail_key) throw new DomainError('NOT_FOUND', 'No preview for this file.');
    return { bytes: await this.store.get(meta.thumbnail_key), contentType: 'image/jpeg' };
  }
}

interface AttachmentRow {
  storage_key: string;
  thumbnail_key: string | null;
  content_type: AllowedType;
  uploaded_by: string;
  project_id: string | null;
  /** Set when the photo belongs to a site visit (before/after). */
  visit_project_id: string | null;
  visit_engineer_id: string | null;
}

/**
 * Linked photos follow the expense's project scope, visit photos the ticket's project (or the
 * visit's engineer); unattached ones are the uploader's.
 */
async function visibleAttachment(
  c: pg.PoolClient,
  actor: Actor,
  id: string,
): Promise<AttachmentRow> {
  const { rows } = await c.query<AttachmentRow>(
    `SELECT a.storage_key, a.thumbnail_key, a.content_type, a.uploaded_by, e.project_id,
            t.project_id AS visit_project_id, sv.engineer_id AS visit_engineer_id
       FROM attachment a LEFT JOIN expense e ON e.attachment_id = a.id AND e.deleted_at IS NULL
       LEFT JOIN visit_photo vp ON vp.attachment_id = a.id
       LEFT JOIN site_visit sv ON sv.id = vp.visit_id
       LEFT JOIN ticket t ON t.id = sv.ticket_id
      WHERE a.id = $1`,
    [id],
  );
  const r = rows[0];
  const allowed = r !== undefined && mayView(actor, r);
  if (!r || !allowed) throw new DomainError('NOT_FOUND', 'File not found.');
  return r;
}

function mayView(actor: Actor, r: AttachmentRow): boolean {
  if (r.visit_project_id !== null)
    return (
      r.visit_engineer_id === actor.userId || can(actor, 'tickets', 'view', r.visit_project_id)
    );
  if (r.project_id !== null) return can(actor, 'expenses', 'view', r.project_id);
  return r.uploaded_by === actor.userId;
}

/** Photos uploaded but not attached to an expense yet, per user (bounds disk use; BUG-106). */
export const MAX_UNCLAIMED_UPLOADS = 20;

async function assertUnclaimedQuota(c: pg.PoolClient): Promise<void> {
  // One upload per user at a time, so concurrent uploads cannot all slip under the quota.
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('upload:' || app_user_id()::text))`);
  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM attachment a
      WHERE a.uploaded_by = app_user_id() AND a.created_at > now() - interval '7 days'
        AND NOT EXISTS (SELECT 1 FROM expense e WHERE e.attachment_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM visit_photo vp WHERE vp.attachment_id = a.id)`,
  );
  if (Number(rows[0]?.n ?? 0) >= MAX_UNCLAIMED_UPLOADS) {
    throw new DomainError(
      'RATE_LIMITED',
      'Too many photos waiting to be attached. Save the expenses you have started first.',
    );
  }
}

/**
 * A not-yet-used attachment uploaded by the actor or, when the Owner corrects someone's
 * expense, by that expense's author (BUG-109).
 */
export async function claimAttachment(
  c: pg.PoolClient,
  actor: Actor,
  attachmentId: string,
  expenseId: string,
  author: string | null = null,
): Promise<void> {
  const { rows } = await c.query<{ uploaded_by: string; used_by: string | null }>(
    `SELECT a.uploaded_by,
            coalesce((SELECT e.id FROM expense e WHERE e.attachment_id = a.id),
                     (SELECT vp.visit_id FROM visit_photo vp WHERE vp.attachment_id = a.id)) AS used_by
       FROM attachment a WHERE a.id = $1`,
    [attachmentId],
  );
  const a = rows[0];
  const mayUse =
    a?.uploaded_by === actor.userId || (canApprove(actor) && a?.uploaded_by === author);
  if (!a || !mayUse)
    throw new DomainError('VALIDATION', 'Upload the bill photo again.', 'attachmentId');
  if (a.used_by && a.used_by !== expenseId)
    throw new DomainError(
      'VALIDATION',
      'This photo is already attached to another expense.',
      'attachmentId',
    );
}
