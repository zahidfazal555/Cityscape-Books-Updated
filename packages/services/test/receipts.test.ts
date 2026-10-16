import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@csd/core';
import { InvoicesService, ReceiptsService } from '../src/index.js';
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
let admin: Actor;

beforeAll(async () => {
  f = await makeCompany('Receipts Co');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
  admin = actorFor(f, await makeUser(f.companyId, 'admin'), 'admin');
});
afterEach(() => setLock(f.companyId, null));
afterAll(closePools);

const newInvoice = async () => {
  const { projectId } = await clientProject(owner);
  return invoices.create(owner, invoiceInput(projectId));
};

describe('client receipts', () => {
  it('part then full payment moves the invoice Unpaid → Partially paid → Paid, posting to the mode’s account', async () => {
    const { id } = await newInvoice();
    const upiBefore = await accountBalance(f.companyId, '1020');
    const r1 = await receipts.record(admin, {
      invoiceId: id,
      receiptDate: '2026-10-11',
      amount: 3_54_000_00,
      mode: 'upi',
      reference: 'UPI-4411',
    });
    expect(r1.number).toMatch(/^RCT\/26-27\/\d{4}$/);
    expect((await invoices.get(admin, id)).status).toBe('partially_paid');
    await receipts.record(admin, {
      invoiceId: id,
      receiptDate: '2026-10-12',
      amount: 8_26_000_00,
      mode: 'cash',
    });
    expect(await invoices.get(admin, id)).toMatchObject({
      status: 'paid',
      balance: 0,
      received: 11_80_000_00,
    });
    expect((await accountBalance(f.companyId, '1020')) - upiBefore).toBe(3_54_000_00);
    const tb = await trialBalance(f.companyId);
    expect(tb.dr).toBe(tb.cr);
  });

  it('validates amount, reference, dates and the invoice state', async () => {
    const { id } = await newInvoice();
    const base = {
      invoiceId: id,
      receiptDate: '2026-10-11',
      mode: 'bank' as const,
      reference: 'UTR1',
    };
    await expect(receipts.record(admin, { ...base, amount: 11_80_000_01 })).rejects.toMatchObject({
      field: 'amount',
    });
    await expect(receipts.record(admin, { ...base, amount: 0 })).rejects.toMatchObject({
      field: 'amount',
    });
    await expect(
      receipts.record(admin, { ...base, amount: 100, reference: '' }),
    ).rejects.toMatchObject({ field: 'reference' });
    await expect(
      receipts.record(admin, { ...base, amount: 100, receiptDate: '2999-01-01' }),
    ).rejects.toMatchObject({ field: 'receiptDate' });
    await expect(
      receipts.record(admin, { ...base, amount: 100, receiptDate: '2026-10-01' }),
    ).rejects.toMatchObject({ field: 'receiptDate' });
    await invoices.cancel(owner, id, { cnDate: '2026-10-12', reason: 'Cancelled' });
    await expect(receipts.record(admin, { ...base, amount: 100 })).rejects.toThrow('cancelled');
  });

  it('concurrent receipts can never together exceed the balance', async () => {
    const { id } = await newInvoice();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        receipts.record(admin, {
          invoiceId: id,
          receiptDate: '2026-10-11',
          amount: 4_00_000_00,
          mode: 'bank',
          reference: `UTR-${i}`,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect((await invoices.get(admin, id)).balance).toBe(3_80_000_00);
  });

  it('deleting a receipt needs full rights, reverses its journal and restores the balance; locked periods refuse it', async () => {
    const { id } = await newInvoice();
    const pm = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager');
    const r = await receipts.record(admin, {
      invoiceId: id,
      receiptDate: '2026-10-11',
      amount: 1_00_000_00,
      mode: 'cheque',
      reference: 'CHQ 0042',
    });
    await expect(receipts.remove(pm, r.id)).rejects.toMatchObject({ status: 403 });
    await receipts.remove(admin, r.id);
    expect((await invoices.get(admin, id)).balance).toBe(11_80_000_00);
    expect((await receipts.list(admin)).map((x) => x.id)).not.toContain(r.id);
    await expect(receipts.remove(admin, r.id)).rejects.toMatchObject({ status: 409 });

    const r2 = await receipts.record(admin, {
      invoiceId: id,
      receiptDate: '2026-10-11',
      amount: 1_00,
      mode: 'cash',
    });
    await setLock(f.companyId, '2026-10-11');
    await expect(receipts.remove(admin, r2.id)).rejects.toMatchObject({ status: 423 });
    await expect(superPool.query('DELETE FROM receipt WHERE id = $1', [r2.id])).rejects.toThrow();
  });

  it('BUG-072: the database itself refuses changes to a receipt in a locked period (app checks bypassed)', async () => {
    const { id } = await newInvoice();
    const r = await receipts.record(admin, {
      invoiceId: id,
      receiptDate: '2026-10-11',
      amount: 1_00,
      mode: 'cash',
    });
    await setLock(f.companyId, '2026-10-15');
    const { withTenant } = await import('@csd/db');
    const ctx = { companyId: f.companyId, userId: f.ownerId };
    await expect(
      withTenant(appPool, ctx, (c) =>
        c.query(`UPDATE receipt SET reference = 'tampered' WHERE id = $1`, [r.id]),
      ),
    ).rejects.toMatchObject({ status: 423 });
    await expect(
      withTenant(appPool, ctx, (c) =>
        c.query(`UPDATE receipt_allocation SET amount = 2 WHERE receipt_id = $1`, [r.id]),
      ),
    ).rejects.toMatchObject({ status: 423 });
  });

  it('BUG-073: view-only users cannot record; scoped users cannot touch other projects’ receipts', async () => {
    const mine = await clientProject(owner);
    const other = await clientProject(owner);
    const invMine = await invoices.create(owner, invoiceInput(mine.projectId));
    const invOther = await invoices.create(owner, invoiceInput(other.projectId));
    const asst = actorFor(f, await makeUser(f.companyId, 'asstmgr'), 'asstmgr');
    const base = { receiptDate: '2026-10-11', amount: 1_00, mode: 'cash' as const };
    await expect(receipts.record(asst, { ...base, invoiceId: invMine.id })).rejects.toMatchObject({
      status: 403,
    });
    const scoped = actorFor(f, await makeUser(f.companyId, 'admin'), 'admin', [mine.projectId]);
    await expect(
      receipts.record(scoped, { ...base, invoiceId: invOther.id }),
    ).rejects.toMatchObject({ status: 404 });
    const theirs = await receipts.record(owner, { ...base, invoiceId: invOther.id });
    await expect(receipts.remove(scoped, theirs.id)).rejects.toMatchObject({ status: 404 });
    const ok = await receipts.record(scoped, { ...base, invoiceId: invMine.id });
    const listed = (await receipts.list(scoped)).map((r) => r.id);
    expect(listed).toContain(ok.id);
    expect(listed).not.toContain(theirs.id);
  });

  it('BUG-081: a blank cash reference is stored as NULL', async () => {
    const { id } = await newInvoice();
    const r = await receipts.record(admin, {
      invoiceId: id,
      receiptDate: '2026-10-11',
      amount: 1_00,
      mode: 'cash',
      reference: '',
    });
    const { rows } = await superPool.query('SELECT reference FROM receipt WHERE id = $1', [r.id]);
    expect(rows[0].reference).toBeNull();
  });
});
