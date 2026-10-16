import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@csd/core';
import { ContactsService, InvoicesService, ReceiptsService } from '../src/index.js';
import {
  actorFor,
  appPool,
  closePools,
  makeCompany,
  makeUser,
  superPool,
  type Fixture,
} from './helpers.js';
import {
  accountBalance,
  clientProject,
  invoiceInput,
  setLock,
  trialBalance,
} from './sales-helpers.js';

const invoices = new InvoicesService(appPool);
const receipts = new ReceiptsService(appPool);
let f: Fixture;
let owner: Actor;
let pm: Actor;

beforeAll(async () => {
  f = await makeCompany('Sales Co');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
  pm = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager');
});
afterEach(() => setLock(f.companyId, null));
afterAll(closePools);

describe('tax invoices', () => {
  it('UAT 4: Tamil Nadu client → CGST + SGST; Karnataka client → IGST; journal balances', async () => {
    const tn = await clientProject(owner, '33');
    const ka = await clientProject(owner, '29');
    const a = await invoices.create(pm, invoiceInput(tn.projectId));
    const b = await invoices.create(pm, invoiceInput(ka.projectId));
    const [ia, ib] = await Promise.all([invoices.get(pm, a.id), invoices.get(pm, b.id)]);
    expect(ia).toMatchObject({
      cgst: 90_000_00,
      sgst: 90_000_00,
      igst: 0,
      total: 11_80_000_00,
      interState: false,
      status: 'unpaid',
    });
    expect(ib).toMatchObject({
      cgst: 0,
      sgst: 0,
      igst: 1_80_000_00,
      total: 11_80_000_00,
      interState: true,
      placeOfSupply: '29',
    });
    expect(ib.clientGstin).toMatch(/^29/);
    const tb = await trialBalance(f.companyId);
    expect(tb.dr).toBe(tb.cr);
    expect(await accountBalance(f.companyId, '2202')).toBe(-1_80_000_00);
  });

  it('numbers are gapless per financial year: CSD/26-27/0001, 0002…', async () => {
    const g = await makeCompany('Numbering Co');
    await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [
      g.companyId,
    ]);
    const o = actorFor(g, g.ownerId, 'owner');
    const { projectId } = await clientProject(o, '33');
    const nums = [];
    for (let i = 0; i < 3; i++)
      nums.push((await invoices.create(o, invoiceInput(projectId))).number);
    expect(nums).toEqual(['CSD/26-27/0001', 'CSD/26-27/0002', 'CSD/26-27/0003']);
  });

  it('refuses future dates, due before invoice date, and dates in a locked period (423)', async () => {
    const { projectId } = await clientProject(owner);
    await expect(
      invoices.create(
        pm,
        invoiceInput(projectId, { invoiceDate: '2999-01-01', dueDate: '2999-01-02' }),
      ),
    ).rejects.toMatchObject({ field: 'invoiceDate' });
    await expect(
      invoices.create(pm, invoiceInput(projectId, { dueDate: '2026-10-01' })),
    ).rejects.toMatchObject({ field: 'dueDate' });
    await setLock(f.companyId, '2026-09-30');
    await expect(
      invoices.create(
        pm,
        invoiceInput(projectId, { invoiceDate: '2026-09-30', dueDate: '2026-10-15' }),
      ),
    ).rejects.toMatchObject({
      status: 423,
      message: 'Books are locked till 30 Sep 2026. Pick a later date.',
    });
  });

  it('snapshots the bill-to details: later contact edits do not change the invoice', async () => {
    const { clientId, projectId } = await clientProject(owner, '33', 'Snapshot Client');
    const { id } = await invoices.create(pm, invoiceInput(projectId));
    await new ContactsService(appPool).update(owner, clientId, {
      name: 'Renamed Client',
      address: 'Elsewhere',
    });
    expect(await invoices.get(pm, id)).toMatchObject({
      clientName: 'Snapshot Client',
      clientAddress: 'Chennai',
    });
  });

  it('edits replace the journal (reversal + new), keep the number, and use optimistic versions', async () => {
    const { projectId } = await clientProject(owner);
    const { id, number } = await invoices.create(pm, invoiceInput(projectId));
    const v1 = await invoices.get(pm, id);
    await invoices.update(pm, id, {
      version: v1.version,
      invoiceDate: '2026-10-12',
      dueDate: '2026-10-30',
      lines: [
        {
          description: 'Revised stage 1',
          qtyMilli: 2500,
          unit: 'sqft',
          rate: 1_000_00,
          gstRate: 18,
        },
      ],
    });
    const v2 = await invoices.get(pm, id);
    expect(v2).toMatchObject({ number, version: 2, taxable: 2_500_00, total: 2_950_00 });
    await expect(
      invoices.update(pm, id, { ...v1, version: 1, lines: v1.lines }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      invoices.update(pm, id, {
        version: 2,
        invoiceDate: '2027-04-02',
        dueDate: '2027-04-10',
        lines: v1.lines,
      }),
    ).rejects.toMatchObject({ field: 'invoiceDate' });
    const { rows } = await superPool.query(
      `SELECT count(*)::int AS n FROM journal WHERE source_id = $1`,
      [id],
    );
    expect(rows[0].n).toBe(3); // original, reversal, new
    const tb = await trialBalance(f.companyId);
    expect(tb.dr).toBe(tb.cr);
  });

  it('UAT 5: cancelling issues a credit note, needs full rights, and leaves nothing receivable', async () => {
    const { projectId } = await clientProject(owner);
    const arBefore = await accountBalance(f.companyId, '1100');
    const { id } = await invoices.create(pm, invoiceInput(projectId));
    await expect(
      invoices.cancel(pm, id, { cnDate: '2026-10-11', reason: 'Raised in error' }),
    ).rejects.toMatchObject({ status: 403 });
    const { creditNote } = await invoices.cancel(owner, id, {
      cnDate: '2026-10-11',
      reason: 'Raised in error',
    });
    expect(creditNote).toMatch(/^CN\/26-27\/\d{4}$/);
    const inv = await invoices.get(owner, id);
    expect(inv).toMatchObject({
      status: 'cancelled',
      balance: 0,
      creditNote: { number: creditNote, reason: 'Raised in error' },
    });
    expect(await accountBalance(f.companyId, '1100')).toBe(arBefore);
    await expect(
      invoices.cancel(owner, id, { cnDate: '2026-10-11', reason: 'Again' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      invoices.update(owner, id, {
        version: inv.version,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        lines: inv.lines,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(superPool.query('DELETE FROM invoice WHERE id = $1', [id])).rejects.toThrow(
      'append-only',
    );
  });

  it('an invoice in a locked month can still be cancelled with a credit note in an open month', async () => {
    const { projectId } = await clientProject(owner);
    const { id } = await invoices.create(
      owner,
      invoiceInput(projectId, { invoiceDate: '2026-09-20', dueDate: '2026-09-30' }),
    );
    await setLock(f.companyId, '2026-09-30');
    await expect(
      invoices.cancel(owner, id, { cnDate: '2026-09-25', reason: 'x' + 'yz' }),
    ).rejects.toMatchObject({ status: 423 });
    await expect(
      invoices.cancel(owner, id, { cnDate: '2026-10-02', reason: 'Client withdrew' }),
    ).resolves.toBeDefined();
    const inv = await invoices.get(owner, id);
    await expect(
      invoices.update(owner, id, {
        version: inv.version,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        lines: inv.lines,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('an invoice with receipts can be neither edited nor cancelled', async () => {
    const { projectId } = await clientProject(owner);
    const { id } = await invoices.create(owner, invoiceInput(projectId));
    await receipts.record(owner, {
      invoiceId: id,
      receiptDate: '2026-10-12',
      amount: 1_00_000_00,
      mode: 'bank',
      reference: 'UTR123',
    });
    const inv = await invoices.get(owner, id);
    await expect(
      invoices.update(owner, id, {
        version: inv.version,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        lines: inv.lines,
      }),
    ).rejects.toThrow('receipts');
    await expect(
      invoices.cancel(owner, id, { cnDate: '2026-10-13', reason: 'Wrong' }),
    ).rejects.toThrow('receipts');
  });

  it('project scope: a scoped user neither lists nor opens other projects’ invoices', async () => {
    const mine = await clientProject(owner);
    const other = await clientProject(owner);
    const a = await invoices.create(owner, invoiceInput(mine.projectId));
    const b = await invoices.create(owner, invoiceInput(other.projectId));
    const scoped = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager', [mine.projectId]);
    const ids = (await invoices.list(scoped)).map((i) => i.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    await expect(invoices.get(scoped, b.id)).rejects.toMatchObject({ status: 404 });
    await expect(invoices.create(scoped, invoiceInput(other.projectId))).rejects.toMatchObject({
      status: 404,
    });
    const site = actorFor(f, await makeUser(f.companyId, 'site'), 'site');
    await expect(invoices.list(site)).rejects.toMatchObject({ status: 403 });
  });
});
