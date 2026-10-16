import { crc32 } from 'node:zlib';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@csd/core';
import {
  ApprovalsService,
  AttachmentsService,
  ExpensesService,
  MAX_UPLOAD_BYTES,
  MemoryBlobStore,
  QuotationsService,
  cleanUpload,
  type ExpenseInput,
} from '../src/index.js';
import {
  actorFor,
  appPool,
  closePools,
  makeCompany,
  makeUser,
  superPool,
  type Fixture,
} from './helpers.js';
import { clientProject, setLock, trialBalance } from './sales-helpers.js';

const store = new MemoryBlobStore();
const files = new AttachmentsService(appPool, store);
const expenses = new ExpensesService(appPool);
const approvals = new ApprovalsService(appPool);
let f: Fixture;
let owner: Actor;
let manager: Actor;
let site: Actor;
let projectId: string;

const seg = (marker: number, body: string) => {
  const b = Buffer.from(body, 'latin1');
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(b.length + 2, 2);
  return Buffer.concat([head, b]);
};
const pixels = (w: number, h: number) => {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([200, 120, 40, 255], i);
  return { width: w, height: h, data };
};
const plain = jpeg.encode(pixels(16, 8), 90).data;
/**
 * A real JPEG as a phone writes it: EXIF with GPS and a comment up front, a second (MPF/gain
 * map) image with its own EXIF appended after the first, and a Motion Photo trailer at the end.
 */
const JPEG = Buffer.concat([
  plain.subarray(0, 2),
  seg(0xe1, 'Exif\0\0GPS 13.0827N 80.2707E'),
  seg(0xfe, 'secret comment'),
  plain.subarray(2),
  Buffer.from([0xff, 0xd8]),
  seg(0xe1, 'Exif\0\0GPS second image'),
  plain.subarray(2),
  Buffer.from('ftypmp42 MotionPhoto GPS trailer', 'latin1'),
]);

const pngChunk = (type: string, data: string) => {
  const t = Buffer.from(type, 'latin1');
  const d = Buffer.from(data, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(d.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, d])) >>> 0);
  return Buffer.concat([len, t, d, crc]);
};
const plainPng = (() => {
  const img = new PNG({ width: 4, height: 4 });
  img.data.fill(128);
  return PNG.sync.write(img);
})();
/** A real PNG with a tEXt chunk inserted before IEND. */
const PNG_WITH_TEXT = Buffer.concat([
  plainPng.subarray(0, plainPng.length - 12),
  pngChunk('tEXt', 'GPS\0Chennai'),
  plainPng.subarray(plainPng.length - 12),
]);

beforeAll(async () => {
  f = await makeCompany('Expenses Co');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
  manager = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager');
  ({ projectId } = await clientProject(owner));
  site = actorFor(f, await makeUser(f.companyId, 'site'), 'site', [projectId]);
});
afterEach(() => setLock(f.companyId, null));
afterAll(closePools);

async function photo(actor: Actor = site): Promise<string> {
  return (await files.upload(actor, JPEG)).id;
}

const input = async (
  over: Partial<ExpenseInput> = {},
  actor: Actor = site,
): Promise<ExpenseInput> => ({
  projectId,
  txnDate: '2026-10-08',
  amount: 2_450_00,
  particulars: 'Cement 10 bags',
  category: 'material',
  paidBy: 'Site Engineer',
  mode: 'upi',
  paidTo: 'Sri Murugan Traders',
  attachmentId: await photo(actor),
  ...over,
});

async function postings(sourceId: string): Promise<Record<string, number>> {
  const { rows } = await superPool.query<{ code: string; net: string }>(
    `SELECT a.code, sum(l.debit - l.credit)::text AS net
       FROM journal j JOIN journal_line l ON l.journal_id = j.id JOIN account a ON a.id = l.account_id
      WHERE j.source_id = $1 GROUP BY a.code`,
    [sourceId],
  );
  return Object.fromEntries(
    rows.filter((r) => Number(r.net) !== 0).map((r) => [r.code, Math.round(Number(r.net) * 100)]),
  );
}

describe('bill photos', () => {
  it('BUG-105: re-encodes images, dropping EXIF/GPS, comments, appended images and trailers', () => {
    const jpg = cleanUpload(JPEG);
    expect(jpg?.type).toBe('image/jpeg');
    const text = jpg!.bytes.toString('latin1');
    for (const leak of ['GPS', 'Exif', 'secret comment', 'MotionPhoto'])
      expect(text).not.toContain(leak);
    // Exactly one image, and it still decodes to the same picture size.
    expect(text.split('\xff\xd8').length - 1).toBe(1);
    expect(jpeg.decode(jpg!.bytes)).toMatchObject({ width: 16, height: 8 });
    const png = cleanUpload(PNG_WITH_TEXT);
    expect(png?.type).toBe('image/png');
    expect(png!.bytes.toString('latin1')).not.toContain('Chennai');
    expect(PNG.sync.read(png!.bytes)).toMatchObject({ width: 4, height: 4 });
    expect(cleanUpload(Buffer.from('%PDF-1.7 hello'))?.type).toBe('application/pdf');
    expect(cleanUpload(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
    // A file that only looks like a JPEG is refused rather than stored.
    expect(cleanUpload(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2]))).toBeNull();
  });

  it('upload refuses other types, empty and oversized files; stores the cleaned bytes', async () => {
    await expect(files.upload(site, Buffer.from('GIF89a'))).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(files.upload(site, Buffer.alloc(0))).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      files.upload(site, Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0xff)),
    ).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
    const { id } = await files.upload(site, JPEG);
    const back = await files.read(site, id);
    expect(back.contentType).toBe('image/jpeg');
    expect(back.bytes.toString('latin1')).not.toContain('GPS');
  });

  it('only the uploader sees an unattached photo; after attaching, anyone who sees the expense; every view is audited', async () => {
    const id = await photo();
    await expect(files.read(manager, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expenses.create(site, await input({ attachmentId: id }));
    await files.read(manager, id);
    const other = await clientProject(owner);
    const outsider = actorFor(f, await makeUser(f.companyId, 'site'), 'site', [other.projectId]);
    await expect(files.read(outsider, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const { rows } = await superPool.query(
      `SELECT 1 FROM audit_log WHERE entity = 'attachment' AND entity_id = $1 AND action = 'view'`,
      [id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('a photo is attached once, and only by its uploader', async () => {
    const id = await photo();
    await expect(
      expenses.create(manager, await input({ attachmentId: id }, manager)),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      field: 'attachmentId',
    });
    await expenses.create(site, await input({ attachmentId: id }));
    await expect(expenses.create(site, await input({ attachmentId: id }))).rejects.toMatchObject({
      code: 'VALIDATION',
      field: 'attachmentId',
    });
  });
});

describe('expenses (FR-11, H2)', () => {
  it('a site engineer’s expense is Pending and posts nothing until the Owner approves', async () => {
    const e = await expenses.create(site, await input());
    expect(e.status).toBe('pending');
    expect(await postings(e.id)).toEqual({});
    await expect(expenses.approve(manager, e.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expenses.approve(owner, e.id);
    expect(await postings(e.id)).toEqual({ '5000': 2_450_00, '1020': -2_450_00 });
    await expect(expenses.approve(owner, e.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    const tb = await trialBalance(f.companyId);
    expect(tb.dr).toBe(tb.cr);
  });

  it('the Owner’s own expense posts at once; a bill photo is required (FR-11.5)', async () => {
    const e = await expenses.create(owner, await input({ mode: 'cash', category: 'fuel' }, owner));
    expect(e.status).toBe('approved');
    expect(await postings(e.id)).toEqual({ '5040': 2_450_00, '1000': -2_450_00 });
    await expect(expenses.create(site, await input({ attachmentId: null }))).rejects.toMatchObject({
      code: 'VALIDATION',
      field: 'attachmentId',
    });
  });

  it('rejects with a reason; a rejected entry edited by its author goes back to Pending', async () => {
    const e = await expenses.create(site, await input());
    await expenses.reject(owner, e.id, { reason: 'Bill unreadable' });
    let view = await expenses.get(site, e.id);
    expect(view).toMatchObject({ status: 'rejected', rejectReason: 'Bill unreadable' });
    const res = await expenses.update(site, e.id, { ...(await input()), version: view.version });
    expect(res.status).toBe('pending');
    view = await expenses.get(site, e.id);
    expect(view.rejectReason).toBeNull();
  });

  it('BUG-104: a non-owner cannot edit (and so un-post or then withdraw) an approved expense; the Owner reposts it', async () => {
    const e = await expenses.create(site, await input());
    await expenses.approve(owner, e.id);
    let v = await expenses.get(owner, e.id);
    await expect(
      expenses.update(site, e.id, { ...(await input()), version: v.version }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(expenses.remove(site, e.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await postings(e.id)).toEqual({ '5000': 2_450_00, '1020': -2_450_00 });
    v = await expenses.get(owner, e.id);
    const r = await expenses.update(owner, e.id, {
      ...(await input({ amount: 3_100_00 }, owner)),
      version: v.version,
    });
    expect(r.status).toBe('approved');
    expect(await postings(e.id)).toEqual({ '5000': 3_100_00, '1020': -3_100_00 });
  });

  it('BUG-109: the Owner can attach the author’s own unused photo; anyone else’s is refused', async () => {
    const e = await expenses.create(site, await input());
    const spare = await photo(site);
    const v = await expenses.get(owner, e.id);
    await expenses.update(owner, e.id, {
      ...(await input({ attachmentId: spare }, owner)),
      version: v.version,
    });
    expect((await expenses.get(owner, e.id)).attachmentId).toBe(spare);
    const mgrPhoto = await photo(manager);
    const v2 = await expenses.get(owner, e.id);
    await expect(
      expenses.update(owner, e.id, {
        ...(await input({ attachmentId: mgrPhoto }, owner)),
        version: v2.version,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', field: 'attachmentId' });
  });

  it('BUG-108: visit expenses and imported rows do not need a photo; approval re-checks the project', async () => {
    const e = await expenses.create(site, await input());
    await superPool.query(
      `UPDATE expense SET source = 'visit', attachment_id = NULL WHERE id = $1`,
      [e.id],
    );
    const v = await expenses.get(site, e.id);
    await expenses.update(site, e.id, {
      ...(await input({ attachmentId: null })),
      version: v.version,
    });
    const other = await clientProject(owner);
    const scopedSite = actorFor(f, await makeUser(f.companyId, 'site'), 'site', [other.projectId]);
    const p = await expenses.create(scopedSite, {
      ...(await input({}, scopedSite)),
      projectId: other.projectId,
    });
    await superPool.query(`UPDATE project SET status = 'cancelled' WHERE id = $1`, [
      other.projectId,
    ]);
    await expect(expenses.approve(owner, p.id)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('BUG-106: a user can hold at most 20 unattached photos', async () => {
    const uploader = actorFor(f, await makeUser(f.companyId, 'site'), 'site', [projectId]);
    for (let i = 0; i < 20; i++) await files.upload(uploader, JPEG);
    await expect(files.upload(uploader, JPEG)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('delete: authors withdraw their pending entries; only the Owner deletes a posted one; payment-created entries are read-only', async () => {
    const mine = await expenses.create(site, await input());
    await expenses.remove(site, mine.id);
    await expect(expenses.get(owner, mine.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const posted = await expenses.create(owner, await input({}, owner));
    const admin = actorFor(f, await makeUser(f.companyId, 'admin'), 'admin');
    await expect(expenses.remove(admin, posted.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expenses.remove(owner, posted.id);
    expect(await postings(posted.id)).toEqual({});
    const wage = await expenses.create(owner, await input({}, owner));
    await superPool.query(`UPDATE expense SET source = 'payroll_wage' WHERE id = $1`, [wage.id]);
    const w = await expenses.get(owner, wage.id);
    await expect(
      expenses.update(owner, wage.id, { ...(await input({}, owner)), version: w.version }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(expenses.remove(owner, wage.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('locked month: pending entries can be rejected or withdrawn, not approved; posted ones cannot be deleted', async () => {
    const a = await expenses.create(site, await input({ txnDate: '2026-10-02' }));
    const b = await expenses.create(site, await input({ txnDate: '2026-10-02' }));
    const c = await expenses.create(site, await input({ txnDate: '2026-10-02' }));
    const posted = await expenses.create(owner, await input({ txnDate: '2026-10-02' }, owner));
    await setLock(f.companyId, '2026-10-03');
    await expect(expenses.approve(owner, a.id)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    await expenses.reject(owner, a.id, { reason: 'Month closed' });
    // Never posted: the rejected one can still be cleared away by its author.
    await expenses.remove(site, a.id);
    await expenses.remove(site, b.id);
    await expect(expenses.remove(owner, posted.id)).rejects.toMatchObject({
      code: 'PERIOD_LOCKED',
    });
    await expect(
      expenses.create(site, await input({ txnDate: '2026-10-02' })),
    ).rejects.toMatchObject({
      code: 'PERIOD_LOCKED',
    });
    // Approve all: the locked one fails, the others still go through.
    await setLock(f.companyId, null);
    const d = await expenses.create(site, await input());
    await setLock(f.companyId, '2026-10-03');
    const res = await expenses.approveMany(owner, { ids: [c.id, d.id] });
    expect(res.approved).toEqual([d.id]);
    expect(res.failed.map((x) => x.id)).toEqual([c.id]);
  });

  it('scope: a site engineer only records on their own sites; filters give count and total; export is audited', async () => {
    const other = await clientProject(owner);
    await expect(
      expenses.create(site, await input({ projectId: other.projectId })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const list = await expenses.list(owner, { projectId, status: 'pending' });
    expect(list.count).toBe(list.rows.length);
    expect(list.total).toBe(list.rows.reduce((s, e) => s + e.amount, 0));
    expect((await expenses.list(site)).rows.every((e) => e.projectId === projectId)).toBe(true);
    const rows = await expenses.export(owner, { status: 'approved' });
    const { rows: audit } = await superPool.query<{ after: { rows: number } }>(
      `SELECT after FROM audit_log WHERE company_id = $1 AND entity = 'expense' AND action = 'export'
        ORDER BY id DESC LIMIT 1`,
      [f.companyId],
    );
    expect(audit[0]?.after.rows).toBe(rows.length);
  });
});

describe('approvals queue (FR-12)', () => {
  it('lists pending expenses, payments and discounts for the Owner only', async () => {
    const e = await expenses.create(site, await input());
    const quotes = new QuotationsService(appPool);
    const { clientId } = await clientProject(owner);
    const q = await quotes.create(manager, {
      clientId,
      title: 'Lobby',
      quoteDate: '2026-10-08',
      validTill: '2026-12-31',
      discountPct: 5,
      lines: [{ description: 'Panelling', qtyMilli: 1000, rate: 50_000_00 }],
    });
    const queue = await approvals.queue(owner);
    expect(queue.expenses.map((x) => x.id)).toContain(e.id);
    expect(queue.discounts.map((x) => x.id)).toContain(q.id);
    expect(await approvals.count(owner)).toBeGreaterThanOrEqual(2);
    await expect(approvals.queue(manager)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
