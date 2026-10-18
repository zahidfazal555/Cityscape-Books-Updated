import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@csd/core';
import {
  BillsService,
  ContactsService,
  PurchaseOrdersService,
  VendorPaymentsService,
  type BillInput,
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
import { accountBalance, clientProject, gstin, setLock, trialBalance } from './sales-helpers.js';

const pos = new PurchaseOrdersService(appPool);
const bills = new BillsService(appPool);
const payments = new VendorPaymentsService(appPool);
const contacts = new ContactsService(appPool);
let f: Fixture;
let owner: Actor;
let manager: Actor;
let n = 0;

beforeAll(async () => {
  f = await makeCompany('Purchases Co');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
  manager = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager');
});
afterEach(() => setLock(f.companyId, null));
afterAll(closePools);

/** A vendor in Tamil Nadu (33) or Karnataka (29), registered or not. */
async function vendor(state: '33' | '29' = '33', registered = true) {
  n += 1;
  const pan = `AB${String.fromCharCode(65 + (n % 26))}DE${String(1000 + n).slice(-4)}F`;
  return contacts.create(owner, {
    type: 'vendor',
    name: `Vendor ${n}`,
    stateCode: state,
    gstin: registered ? gstin(`${state}${pan}1Z`) : null,
  });
}

const billInput = (
  vendorId: string,
  projectId: string,
  over: Partial<BillInput> = {},
): BillInput => ({
  vendorId,
  projectId,
  billNo: `B-${++n}`,
  billDate: '2026-10-05',
  dueDate: '2027-03-31',
  category: 'material',
  taxable: 1_00_000_00,
  gstRate: 18,
  ...over,
});

/** Journal lines of one source document, as code → net (debit − credit). */
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

describe('purchase bills (FR-10.2, SPEC-FIXES A2)', () => {
  it('in-state registered vendor: cost = taxable, CGST+SGST to input credit, AP = total', async () => {
    const { projectId } = await clientProject(owner);
    const { id } = await bills.create(owner, billInput(await vendor('33'), projectId));
    expect(await postings(id)).toEqual({
      '5000': 1_00_000_00,
      '1200': 9_000_00,
      '1201': 9_000_00,
      '2000': -1_18_000_00,
    });
    expect(await bills.get(owner, id)).toMatchObject({ status: 'unpaid', balance: 1_18_000_00 });
  });

  it('out-of-state vendor: IGST; unregistered: no GST, cost = total; blocked ITC: GST is cost', async () => {
    const { projectId } = await clientProject(owner);
    const igst = await bills.create(
      owner,
      billInput(await vendor('29'), projectId, { category: 'transport' }),
    );
    expect(await postings(igst.id)).toEqual({
      '5030': 1_00_000_00,
      '1202': 18_000_00,
      '2000': -1_18_000_00,
    });
    const unreg = await bills.create(owner, billInput(await vendor('33', false), projectId));
    expect(await postings(unreg.id)).toEqual({ '5000': 1_00_000_00, '2000': -1_00_000_00 });
    const blocked = await bills.create(
      owner,
      billInput(await vendor('33'), projectId, { itcEligible: false }),
    );
    expect(await postings(blocked.id)).toEqual({ '5000': 1_18_000_00, '2000': -1_18_000_00 });
  });

  it('rounds the total to the rupee with a round-off posting', async () => {
    const { projectId } = await clientProject(owner);
    // ₹1,000.30 + 18% = ₹1,180.354 → ₹1,180.35 GST split → total ₹1,180 with −₹0.35 round-off.
    const { id } = await bills.create(
      owner,
      billInput(await vendor('33'), projectId, { taxable: 1_000_30 }),
    );
    const b = await bills.get(owner, id);
    expect(b.total % 100).toBe(0);
    expect(b.total).toBe(b.taxable + b.cgst + b.sgst + b.igst + b.roundOff);
    const tb = await trialBalance(f.companyId);
    expect(tb.dr).toBe(tb.cr);
  });

  it('a vendor bill number is entered once', async () => {
    const { projectId } = await clientProject(owner);
    const v = await vendor();
    await bills.create(owner, billInput(v, projectId, { billNo: 'INV-77' }));
    await expect(
      bills.create(owner, billInput(v, projectId, { billNo: 'inv-77' })),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      field: 'billNo',
    });
  });

  it('edits repost; never below what is paid or pending; deletes only unpaid bills (bills = full)', async () => {
    const { projectId } = await clientProject(owner);
    const v = await vendor();
    const { id } = await bills.create(owner, billInput(v, projectId));
    let b = await bills.get(owner, id);
    await bills.update(owner, id, {
      ...billInput(v, projectId, { billNo: b.billNo, taxable: 50_000_00 }),
      version: b.version,
    });
    expect(await postings(id)).toEqual({
      '5000': 50_000_00,
      '1200': 4_500_00,
      '1201': 4_500_00,
      '2000': -59_000_00,
    });
    await payments.record(manager, {
      billId: id,
      payDate: '2026-10-06',
      amount: 40_000_00,
      mode: 'cash',
    });
    b = await bills.get(owner, id);
    expect(b.pending).toBe(40_000_00);
    await expect(
      bills.update(owner, id, {
        ...billInput(v, projectId, { billNo: b.billNo, taxable: 30_000_00 }),
        version: b.version,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(bills.remove(owner, id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(bills.remove(manager, id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = await bills.create(owner, billInput(v, projectId));
    await bills.remove(owner, other.id);
    await expect(bills.get(owner, other.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await postings(other.id)).toEqual({});
  });

  it('respects the lock date and refuses future bills', async () => {
    const { projectId } = await clientProject(owner);
    const v = await vendor();
    await setLock(f.companyId, '2026-10-05');
    await expect(bills.create(owner, billInput(v, projectId))).rejects.toMatchObject({
      code: 'PERIOD_LOCKED',
    });
    await expect(
      bills.create(
        owner,
        billInput(v, projectId, { billDate: '2099-01-01', dueDate: '2099-01-31' }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', field: 'billDate' });
  });
});

describe('vendor payments (FR-10.3, H2)', () => {
  it('the owner’s payment posts at once: Dr AP / Cr bank, with TDS to TDS payable', async () => {
    const { projectId } = await clientProject(owner);
    const { id: billId } = await bills.create(owner, billInput(await vendor(), projectId));
    const pay = await payments.record(owner, {
      billId,
      payDate: '2026-10-07',
      amount: 1_18_000_00,
      tds: 1_000_00,
      mode: 'bank',
      reference: 'UTR-1',
      paidBy: 'Saravanan',
    });
    expect(pay.status).toBe('approved');
    expect(await postings(pay.id)).toEqual({
      '2000': 1_18_000_00,
      '1010': -1_17_000_00,
      '2310': -1_000_00,
    });
    expect(await bills.get(owner, billId)).toMatchObject({ status: 'paid', balance: 0 });
  });

  it('a manager’s payment waits for the owner, holds the balance, and posts only when approved', async () => {
    const { projectId } = await clientProject(owner);
    const { id: billId } = await bills.create(owner, billInput(await vendor(), projectId));
    const pay = await payments.record(manager, {
      billId,
      payDate: '2026-10-07',
      amount: 1_00_000_00,
      mode: 'upi',
      reference: 'U-1',
    });
    expect(pay.status).toBe('pending');
    expect(await postings(pay.id)).toEqual({});
    // The pending amount is held: another ₹20,000 would over-commit the ₹1,18,000 bill.
    await expect(
      payments.record(owner, { billId, payDate: '2026-10-07', amount: 20_000_00, mode: 'cash' }),
    ).rejects.toMatchObject({ code: 'VALIDATION', field: 'amount' });
    await expect(payments.approve(manager, pay.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await payments.pending(owner)).map((p) => p.id)).toContain(pay.id);
    await payments.approve(owner, pay.id);
    expect(await postings(pay.id)).toEqual({ '2000': 1_00_000_00, '1020': -1_00_000_00 });
    await expect(payments.approve(owner, pay.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await bills.get(owner, billId)).toMatchObject({
      status: 'partially_paid',
      paid: 1_00_000_00,
      pending: 0,
    });
  });

  it('rejects with a reason (nothing posts); a pending payment can be withdrawn by its author', async () => {
    const { projectId } = await clientProject(owner);
    const { id: billId } = await bills.create(owner, billInput(await vendor(), projectId));
    const a = await payments.record(manager, {
      billId,
      payDate: '2026-10-07',
      amount: 10_000_00,
      mode: 'cash',
    });
    await expect(payments.reject(owner, a.id, { reason: '' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await payments.reject(owner, a.id, { reason: 'Wrong bill' });
    const [rejected] = await payments.list(owner, { billId, status: 'rejected' });
    expect(rejected).toMatchObject({ rejectReason: 'Wrong bill' });
    const b = await payments.record(manager, {
      billId,
      payDate: '2026-10-07',
      amount: 10_000_00,
      mode: 'cash',
    });
    await payments.remove(manager, b.id);
    expect((await bills.get(owner, billId)).pending).toBe(0);
  });

  it('deleting an approved payment reverses it (bills = full only)', async () => {
    const { projectId } = await clientProject(owner);
    const { id: billId } = await bills.create(owner, billInput(await vendor(), projectId));
    const pay = await payments.record(owner, {
      billId,
      payDate: '2026-10-07',
      amount: 18_000_00,
      mode: 'cash',
    });
    await expect(payments.remove(manager, pay.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await payments.remove(owner, pay.id);
    expect(await postings(pay.id)).toEqual({});
    expect((await bills.get(owner, billId)).paid).toBe(0);
  });

  it('two concurrent payments can never exceed the bill', async () => {
    const { projectId } = await clientProject(owner);
    const { id: billId } = await bills.create(owner, billInput(await vendor(), projectId));
    const pay = () =>
      payments.record(owner, { billId, payDate: '2026-10-07', amount: 70_000_00, mode: 'cash' });
    const results = await Promise.allSettled([pay(), pay()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('approval is refused into a locked period', async () => {
    const { projectId } = await clientProject(owner);
    const { id: billId } = await bills.create(
      owner,
      billInput(await vendor(), projectId, { billDate: '2026-10-01' }),
    );
    const pay = await payments.record(manager, {
      billId,
      payDate: '2026-10-02',
      amount: 1_000_00,
      mode: 'cash',
    });
    await setLock(f.companyId, '2026-10-03');
    await expect(payments.approve(owner, pay.id)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
  });

  it('AP clears to zero for fully paid bills and the books balance', async () => {
    const { projectId } = await clientProject(owner);
    const v = await vendor();
    const apBefore = await accountBalance(f.companyId, '2000');
    const { id: billId } = await bills.create(owner, billInput(v, projectId));
    await payments.record(owner, {
      billId,
      payDate: '2026-10-07',
      amount: 1_18_000_00,
      mode: 'cash',
    });
    expect(await accountBalance(f.companyId, '2000')).toBe(apBefore);
    const tb = await trialBalance(f.companyId);
    expect(tb.dr).toBe(tb.cr);
  });
});

describe('purchase orders (FR-9)', () => {
  it('draft → issued; partly billed and billed are derived; cancel refused once billed', async () => {
    const { projectId } = await clientProject(owner);
    const v = await vendor('33');
    const po = await pos.create(owner, {
      vendorId: v,
      projectId,
      gstRate: 18,
      poDate: '2026-10-01',
      deliverBy: '2026-10-03',
      lines: [{ description: 'Plywood 18mm', qtyMilli: 100_000, unit: 'sheet', rate: 2_000_00 }],
    });
    expect(po.number).toMatch(/^PO\/26-27\/\d{4}$/);
    let view = await pos.get(owner, po.id);
    expect(view).toMatchObject({ status: 'draft', taxable: 2_00_000_00, total: 2_36_000_00 });
    // A draft cannot be billed against.
    await expect(
      bills.create(
        owner,
        billInput(v, projectId, { purchaseOrderId: po.id, taxable: 1_00_000_00 }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', field: 'purchaseOrderId' });
    await pos.issue(owner, po.id);
    expect((await pos.get(owner, po.id)).overdue).toBe(true);
    await bills.create(
      owner,
      billInput(v, projectId, { purchaseOrderId: po.id, taxable: 1_20_000_00 }),
    );
    view = await pos.get(owner, po.id);
    expect(view).toMatchObject({
      status: 'partly_billed',
      billed: 1_20_000_00,
      unbilled: 80_000_00,
    });
    await bills.create(
      owner,
      billInput(v, projectId, { purchaseOrderId: po.id, taxable: 80_000_00 }),
    );
    view = await pos.get(owner, po.id);
    expect(view).toMatchObject({ status: 'billed', unbilled: 0, overdue: false });
    expect(view.bills).toHaveLength(2);
    await expect(pos.cancel(owner, po.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    // A PO posts nothing.
    expect(await postings(po.id)).toEqual({});
  });

  it('unregistered vendor gets no GST; only drafts are deleted; bills must match vendor and project', async () => {
    const { projectId } = await clientProject(owner);
    const other = await clientProject(owner);
    const v = await vendor('33', false);
    const po = await pos.create(owner, {
      vendorId: v,
      projectId,
      gstRate: 18,
      poDate: '2026-10-01',
      lines: [{ description: 'Labour', qtyMilli: 1000, rate: 10_000_00 }],
    });
    expect(await pos.get(owner, po.id)).toMatchObject({ gstRate: 0, total: 10_000_00 });
    await pos.issue(owner, po.id);
    await expect(pos.remove(owner, po.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      bills.create(owner, billInput(v, other.projectId, { purchaseOrderId: po.id })),
    ).rejects.toMatchObject({ code: 'VALIDATION', field: 'purchaseOrderId' });
    await pos.cancel(owner, po.id);
    const draft = await pos.create(owner, {
      vendorId: v,
      projectId,
      poDate: '2026-10-01',
      lines: [{ description: 'Labour', qtyMilli: 1000, rate: 1_000_00 }],
    });
    await pos.remove(owner, draft.id);
    await expect(pos.get(owner, draft.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('scoped users do not see purchases of other projects', async () => {
    const { projectId } = await clientProject(owner);
    const v = await vendor();
    const { id: billId } = await bills.create(owner, billInput(v, projectId));
    const scoped = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager', []);
    await expect(bills.get(scoped, billId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await bills.list(scoped)).map((b) => b.id)).not.toContain(billId);
    await expect(
      payments.record(scoped, { billId, payDate: '2026-10-07', amount: 1_00, mode: 'cash' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(bills.create(scoped, billInput(v, projectId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('review regressions (PR 9)', () => {
  it('BUG-098/100: approvals = full does not make a non-owner an approver; only the Owner reverses a posted payment', async () => {
    const { projectId } = await clientProject(owner);
    const { id: billId } = await bills.create(owner, billInput(await vendor(), projectId));
    const base = actorFor(f, await makeUser(f.companyId, 'admin'), 'admin');
    const admin: Actor = { ...base, rights: { ...base.rights, approvals: 'full' } };
    const pay = await payments.record(admin, {
      billId,
      payDate: '2026-10-07',
      amount: 1_000_00,
      mode: 'cash',
    });
    expect(pay.status).toBe('pending');
    await expect(payments.approve(admin, pay.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(payments.pending(admin)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await payments.approve(owner, pay.id);
    // Admin holds bills = full, but reversing a posted payment is the Owner's call.
    await expect(payments.remove(admin, pay.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await payments.remove(owner, pay.id);
  });

  it('BUG-099: only the Owner (all projects) reads the approval queue; a scoped user with approvals = full cannot', async () => {
    const { projectId } = await clientProject(owner);
    const { id: billId } = await bills.create(owner, billInput(await vendor(), projectId));
    const pay = await payments.record(manager, {
      billId,
      payDate: '2026-10-07',
      amount: 1_000_00,
      mode: 'cash',
    });
    const scoped: Actor = {
      ...manager,
      projects: [],
      rights: { ...manager.rights, approvals: 'full' },
    };
    await expect(payments.pending(scoped)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await payments.pending(owner)).map((p) => p.id)).toContain(pay.id);
  });

  it('BUG-101: editing a bill keeps its GSTIN snapshot even if the vendor master changes or is archived', async () => {
    const { projectId } = await clientProject(owner);
    const v = await vendor('33');
    const { id } = await bills.create(owner, billInput(v, projectId));
    await superPool.query(`UPDATE contact SET gstin = NULL, deleted_at = now() WHERE id = $1`, [v]);
    const b = await bills.get(owner, id);
    await bills.update(owner, id, {
      ...billInput(v, projectId, { billNo: b.billNo, notes: 'Corrected note' }),
      version: b.version,
    });
    expect(await postings(id)).toEqual({
      '5000': 1_00_000_00,
      '1200': 9_000_00,
      '1201': 9_000_00,
      '2000': -1_18_000_00,
    });
    expect((await bills.get(owner, id)).vendorGstin).toBe(b.vendorGstin);
  });

  it('BUG-102: a bill cannot be re-dated after its first payment', async () => {
    const { projectId } = await clientProject(owner);
    const v = await vendor();
    const { id } = await bills.create(owner, billInput(v, projectId, { billDate: '2026-10-01' }));
    await payments.record(manager, {
      billId: id,
      payDate: '2026-10-02',
      amount: 1_000_00,
      mode: 'cash',
    });
    const b = await bills.get(owner, id);
    await expect(
      bills.update(owner, id, {
        ...billInput(v, projectId, { billNo: b.billNo, billDate: '2026-10-10' }),
        version: b.version,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', field: 'billDate' });
  });

  it('BUG-103: a pending payment in a now-locked month can still be rejected or withdrawn, but not approved', async () => {
    const { projectId } = await clientProject(owner);
    const { id: billId } = await bills.create(
      owner,
      billInput(await vendor(), projectId, { billDate: '2026-10-01' }),
    );
    const a = await payments.record(manager, {
      billId,
      payDate: '2026-10-02',
      amount: 1_000_00,
      mode: 'cash',
    });
    const b = await payments.record(manager, {
      billId,
      payDate: '2026-10-02',
      amount: 1_000_00,
      mode: 'cash',
    });
    await setLock(f.companyId, '2026-10-03');
    await expect(payments.approve(owner, a.id)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    await payments.reject(owner, a.id, { reason: 'Month closed' });
    await payments.remove(manager, b.id);
    expect((await bills.get(owner, billId)).pending).toBe(0);
    // Any other change to a locked payment row stays blocked.
    await expect(
      superPool.query(`UPDATE vendor_payment SET reference = 'x' WHERE id = $1`, [a.id]),
    ).rejects.toMatchObject({ code: 'CB423' });
  });

  it('locked periods: an approved payment or a bill in a locked month cannot be deleted', async () => {
    const { projectId } = await clientProject(owner);
    const { id: billId } = await bills.create(
      owner,
      billInput(await vendor(), projectId, { billDate: '2026-10-01' }),
    );
    const pay = await payments.record(owner, {
      billId,
      payDate: '2026-10-02',
      amount: 1_000_00,
      mode: 'cash',
    });
    const other = await bills.create(
      owner,
      billInput(await vendor(), projectId, { billDate: '2026-10-01' }),
    );
    await setLock(f.companyId, '2026-10-03');
    await expect(payments.remove(owner, pay.id)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    await expect(bills.remove(owner, other.id)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
  });

  it('PO state machine: only drafts are edited or issued; no bills against cancelled POs', async () => {
    const { projectId } = await clientProject(owner);
    const v = await vendor();
    const line = { description: 'Cement', qtyMilli: 10_000, unit: 'bag', rate: 400_00 };
    const po = await pos.create(owner, {
      vendorId: v,
      projectId,
      poDate: '2026-10-01',
      lines: [line],
    });
    await pos.issue(owner, po.id);
    await expect(pos.issue(owner, po.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    const view = await pos.get(owner, po.id);
    await expect(
      pos.update(owner, po.id, { poDate: '2026-10-01', lines: [line], version: view.version }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await pos.cancel(owner, po.id);
    await expect(
      bills.create(owner, billInput(v, projectId, { purchaseOrderId: po.id })),
    ).rejects.toMatchObject({ code: 'VALIDATION', field: 'purchaseOrderId' });
  });
});

describe('PO detail shows the vendor’s current registration (BUG-117)', () => {
  it('reports the GSTIN on the master, not only the snapshot', async () => {
    const { projectId } = await clientProject(owner);
    const v = await vendor('33', false);
    const po = await pos.create(owner, {
      vendorId: v,
      projectId,
      poDate: '2026-10-01',
      lines: [{ description: 'Sand', qtyMilli: 1000, rate: 1_000_00 }],
    });
    const g = gstin('33ABQDE1234F1Z');
    await superPool.query('UPDATE contact SET gstin = $2 WHERE id = $1', [v, g]);
    const view = await pos.get(owner, po.id);
    expect(view.vendorGstin).toBeNull();
    expect(view.currentVendor).toEqual({ gstin: g, stateCode: '33' });
  });
});
