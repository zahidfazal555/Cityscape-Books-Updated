import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@csd/core';
import {
  AuditService,
  ContactsService,
  InvoicesService,
  OutstandingService,
  ReceiptsService,
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
import { clientProject, invoiceInput } from './sales-helpers.js';

const invoices = new InvoicesService(appPool);
const receipts = new ReceiptsService(appPool);
const outstanding = new OutstandingService(appPool);
const audit = new AuditService(appPool);
let f: Fixture;
let owner: Actor;

beforeAll(async () => {
  f = await makeCompany('PDF Co');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
});
afterAll(closePools);

const lastAudit = async (entity: string) =>
  (
    await superPool.query(
      `SELECT action, entity_id, after FROM audit_log
        WHERE company_id = $1 AND entity = $2 ORDER BY id DESC LIMIT 1`,
      [f.companyId, entity],
    )
  ).rows[0];

describe('one receipt for its printed copy', () => {
  it('returns the client and project details; other projects and unknown ids are 404', async () => {
    const mine = await clientProject(owner, '33', 'Receipt Client');
    const other = await clientProject(owner);
    const inv = await invoices.create(owner, invoiceInput(mine.projectId));
    const r = await receipts.record(owner, {
      invoiceId: inv.id,
      receiptDate: '2026-10-11',
      amount: 25_000_00,
      mode: 'upi',
      reference: 'UTR123',
    });
    const got = await receipts.get(owner, r.id);
    expect(got).toMatchObject({
      number: r.number,
      clientName: 'Receipt Client',
      clientAddress: 'Chennai',
      invoiceNumber: inv.number,
      amount: 25_000_00,
      mode: 'upi',
      reference: 'UTR123',
    });
    expect(got.projectName).toBe('Project for Receipt Client');

    const scoped = actorFor(f, await makeUser(f.companyId, 'admin'), 'admin', [other.projectId]);
    await expect(receipts.get(scoped, r.id)).rejects.toMatchObject({ status: 404 });
    await expect(receipts.get(owner, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject(
      { status: 404 },
    );
  });
});

describe('client statement of account', () => {
  it('lists invoices, receipts and credit notes with a running balance; deleted receipts drop out', async () => {
    const { clientId, projectId } = await clientProject(owner, '33', 'Statement Client');
    const inv1 = await invoices.create(owner, invoiceInput(projectId));
    const total = (await invoices.get(owner, inv1.id)).total;
    const r1 = await receipts.record(owner, {
      invoiceId: inv1.id,
      receiptDate: '2026-10-11',
      amount: 1_00_000_00,
      mode: 'cash',
    });
    const r2 = await receipts.record(owner, {
      invoiceId: inv1.id,
      receiptDate: '2026-10-12',
      amount: 50_000_00,
      mode: 'cash',
    });
    await receipts.remove(owner, r2.id);
    const inv2 = await invoices.create(
      owner,
      invoiceInput(projectId, { invoiceDate: '2026-10-12' }),
    );
    const { creditNote } = await invoices.cancel(owner, inv2.id, {
      cnDate: '2026-10-13',
      reason: 'Raised in error',
    });

    const all = await outstanding.statement(owner, clientId, {
      from: '2026-04-01',
      to: '2026-10-31',
    });
    expect(all.client.name).toBe('Statement Client');
    expect(all.opening).toBe(0);
    expect(all.lines.map((l) => [l.date, l.debit, l.credit, l.balance])).toEqual([
      ['2026-10-10', total, 0, total],
      ['2026-10-11', 0, 1_00_000_00, total - 1_00_000_00],
      ['2026-10-12', total, 0, 2 * total - 1_00_000_00],
      ['2026-10-13', 0, total, total - 1_00_000_00],
    ]);
    expect(all.lines[0]!.particulars).toContain(inv1.number);
    expect(all.lines[1]!.particulars).toContain(r1.number);
    expect(all.lines[3]!.particulars).toContain(creditNote);
    expect(all.lines.some((l) => l.particulars.includes(r2.number))).toBe(false);
    expect(all.closing).toBe(total - 1_00_000_00);

    const later = await outstanding.statement(owner, clientId, {
      from: '2026-10-11',
      to: '2026-10-31',
    });
    expect(later.opening).toBe(total);
    expect(later.lines).toHaveLength(3);
    expect(later.closing).toBe(all.closing);
  });

  it('only clients have statements; dates are validated; another project’s client is a 404', async () => {
    const vendorId = await new ContactsService(appPool).create(owner, {
      type: 'vendor',
      name: 'Not A Client',
      stateCode: '33',
    });
    await expect(outstanding.statement(owner, vendorId)).rejects.toMatchObject({ status: 404 });
    const { clientId, projectId } = await clientProject(owner);
    await invoices.create(owner, invoiceInput(projectId));
    await expect(
      outstanding.statement(owner, clientId, { from: '2026-10-31', to: '2026-10-01' }),
    ).rejects.toMatchObject({ field: 'from' });
    await expect(
      outstanding.statement(owner, clientId, { from: '2026-02-30' }),
    ).rejects.toMatchObject({ field: 'from' });

    const elsewhere = await clientProject(owner);
    const scoped = actorFor(f, await makeUser(f.companyId, 'admin'), 'admin', [
      elsewhere.projectId,
    ]);
    // Outside the caller's projects the client does not exist for them: no name, GSTIN or address.
    await expect(
      outstanding.statement(scoped, clientId, { from: '2026-04-01', to: '2026-10-31' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('PDF downloads are audited (H4)', () => {
  it('list exports record their format; a document PDF records the document', async () => {
    await invoices.export(owner, {}, 'pdf');
    expect((await lastAudit('invoice')).after.format).toBe('pdf');
    await invoices.export(owner);
    expect((await lastAudit('invoice')).after.format).toBe('csv');

    const { projectId } = await clientProject(owner);
    const inv = await invoices.create(owner, invoiceInput(projectId));
    const pm = actorFor(f, await makeUser(f.companyId, 'site'), 'site');
    await expect(
      audit.recordDocumentPdf(pm, {
        module: 'invoices',
        entity: 'invoice',
        entityId: inv.id,
        number: 'x',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await audit.recordDocumentPdf(owner, {
      module: 'invoices',
      entity: 'invoice',
      entityId: inv.id,
      number: inv.number,
    });
    expect(await lastAudit('invoice')).toMatchObject({
      action: 'export',
      entity_id: inv.id,
      after: { format: 'pdf', number: inv.number },
    });
  });
});
