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
/** A minimal JPEG with JFIF, an EXIF segment carrying "GPS" and a comment. */
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  seg(0xe0, 'JFIF\0\x01\x01'),
  seg(0xe1, 'Exif\0\0GPS 13.0827N 80.2707E'),
  seg(0xfe, 'secret comment'),
  seg(0xdb, 'quant-table'),
  Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x11, 0x22, 0xff, 0xd9]),
]);

const chunk = (type: string, data: string) => {
  const d = Buffer.from(data, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(d.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), d, Buffer.alloc(4)]);
};
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', '0123456789abc'),
  chunk('tEXt', 'GPS\0Chennai'),
  chunk('IDAT', 'pixels'),
  chunk('IEND', ''),
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
  it('sniffs the type and strips EXIF/GPS and comments from JPEGs and text chunks from PNGs', () => {
    const jpg = cleanUpload(JPEG);
    expect(jpg?.type).toBe('image/jpeg');
    const text = jpg!.bytes.toString('latin1');
    expect(text).toContain('JFIF');
    expect(text).not.toContain('GPS');
    expect(text).not.toContain('secret comment');
    expect(text).toContain('quant-table');
    const png = cleanUpload(PNG);
    expect(png?.type).toBe('image/png');
    expect(png!.bytes.toString('latin1')).not.toContain('Chennai');
    expect(png!.bytes.toString('latin1')).toContain('IDAT');
    expect(cleanUpload(Buffer.from('%PDF-1.7 hello'))?.type).toBe('application/pdf');
    expect(cleanUpload(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
    // A truncated JPEG is refused rather than stored half-cleaned.
    expect(cleanUpload(JPEG.subarray(0, 12))).toBeNull();
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

  it('editing a posted expense: a non-owner sends it back to Pending (reversed); the Owner reposts it', async () => {
    const e = await expenses.create(owner, await input({}, owner));
    let v = await expenses.get(owner, e.id);
    const r1 = await expenses.update(manager, e.id, {
      ...(await input({ amount: 3_000_00 }, manager)),
      version: v.version,
    });
    expect(r1.status).toBe('pending');
    expect(await postings(e.id)).toEqual({});
    v = await expenses.get(owner, e.id);
    const r2 = await expenses.update(owner, e.id, {
      ...(await input({ amount: 3_100_00 }, owner)),
      version: v.version,
    });
    expect(r2.status).toBe('approved');
    expect(await postings(e.id)).toEqual({ '5000': 3_100_00, '1020': -3_100_00 });
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
