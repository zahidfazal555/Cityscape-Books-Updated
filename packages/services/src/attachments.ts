import { createHash, randomUUID } from 'node:crypto';
import { DomainError, assertId, authorize, can, type Actor } from '@csd/core';
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
    await this.store.put(key, clean.bytes);
    await withTenant(this.pool, ctx(actor), async (c) => {
      await c.query(
        `INSERT INTO attachment (id, company_id, storage_key, content_type, size_bytes, sha256, uploaded_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, app_user_id())`,
        [
          id,
          key,
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
      const { rows } = await c.query<{
        storage_key: string;
        content_type: AllowedType;
        uploaded_by: string;
        project_id: string | null;
      }>(
        `SELECT a.storage_key, a.content_type, a.uploaded_by, e.project_id
           FROM attachment a LEFT JOIN expense e ON e.attachment_id = a.id AND e.deleted_at IS NULL
          WHERE a.id = $1`,
        [id],
      );
      const r = rows[0];
      const allowed =
        r !== undefined &&
        (r.project_id === null
          ? r.uploaded_by === actor.userId
          : can(actor, 'expenses', 'view', r.project_id));
      if (!r || !allowed) throw new DomainError('NOT_FOUND', 'File not found.');
      await writeAudit(c, { action: 'view', entity: 'attachment', entityId: id });
      return r;
    });
    return { bytes: await this.store.get(meta.storage_key), contentType: meta.content_type };
  }
}

/** The uploader's own, not-yet-used attachment; used when an expense links its photo. */
export async function claimAttachment(
  c: pg.PoolClient,
  actor: Actor,
  attachmentId: string,
  expenseId: string,
): Promise<void> {
  const { rows } = await c.query<{ uploaded_by: string; used_by: string | null }>(
    `SELECT a.uploaded_by, (SELECT e.id FROM expense e WHERE e.attachment_id = a.id) AS used_by
       FROM attachment a WHERE a.id = $1`,
    [attachmentId],
  );
  const a = rows[0];
  if (!a || a.uploaded_by !== actor.userId)
    throw new DomainError('VALIDATION', 'Upload the bill photo again.', 'attachmentId');
  if (a.used_by && a.used_by !== expenseId)
    throw new DomainError(
      'VALIDATION',
      'This photo is already attached to another expense.',
      'attachmentId',
    );
}
