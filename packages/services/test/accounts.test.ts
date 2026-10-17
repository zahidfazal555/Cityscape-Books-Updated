import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@csd/core';
import {
  BankingService,
  BillsService,
  ContactsService,
  GstService,
  InvoicesService,
  OutstandingService,
  ProformasService,
  ProjectsService,
  ReceiptsService,
  ReportsService,
  VendorPaymentsService,
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
import { gstin, invoiceInput } from './sales-helpers.js';

const banking = new BankingService(appPool);
const gst = new GstService(appPool);
const outstanding = new OutstandingService(appPool);
const reports = new ReportsService(appPool);
const invoices = new InvoicesService(appPool);
const receipts = new ReceiptsService(appPool);
const proformas = new ProformasService(appPool);
const bills = new BillsService(appPool);
const payments = new VendorPaymentsService(appPool);
const contacts = new ContactsService(appPool);
const projects = new ProjectsService(appPool);

let f: Fixture;
let owner: Actor;
let manager: Actor;
let projectId: string;
let b2bInvoice: string;

beforeAll(async () => {
  f = await makeCompany('Accounts Co');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  await superPool.query(`UPDATE company SET gstin = $2 WHERE id = $1`, [
    f.companyId,
    gstin('33AAACC1234D1Z'),
  ]);
  owner = actorFor(f, f.ownerId, 'owner');
  manager = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager');
  const clientId = await contacts.create(owner, {
    type: 'client',
    name: 'Registered Client',
    stateCode: '33',
    gstin: gstin('33AAKFV7731M1Z'),
  });
  ({ id: projectId } = await projects.create(owner, {
    name: 'Accounts project',
    clientId,
    startDate: '2026-04-01',
    contractValue: 20_00_000_00,
    costBudget: 10_00_000_00,
  }));
  // October: a B2B invoice ₹1,00,000 + 18%, a cancelled one (credit note in October), a receipt.
  b2bInvoice = (
    await invoices.create(
      owner,
      invoiceInput(projectId, {
        invoiceDate: '2026-10-05',
        lines: [{ description: 'Stage 1', qtyMilli: 1000, rate: 1_00_000_00, gstRate: 18 }],
      }),
    )
  ).id;
  const cancelled = await invoices.create(
    owner,
    invoiceInput(projectId, {
      invoiceDate: '2026-10-06',
      lines: [{ description: 'Wrong', qtyMilli: 1000, rate: 10_000_00, gstRate: 18 }],
    }),
  );
  await invoices.cancel(owner, cancelled.id, { cnDate: '2026-10-07', reason: 'Raised in error' });
  await receipts.record(owner, {
    invoiceId: b2bInvoice,
    receiptDate: '2026-10-08',
    amount: 18_000_00,
    mode: 'bank',
    reference: 'UTR-1',
  });
  // Advances: one received in September and invoiced in October (11B), one received in October (11A).
  const pfSep = await proformas.create(owner, {
    projectId,
    stage: 'Advance',
    pfDate: '2026-09-10',
    dueDate: '2026-09-20',
    lines: [{ description: 'Advance', qtyMilli: 1000, rate: 50_000_00 }],
  });
  await receipts.record(owner, {
    proformaId: pfSep.id,
    receiptDate: '2026-09-12',
    amount: 59_000_00,
    mode: 'cash',
  });
  await proformas.convert(owner, pfSep.id, { invoiceDate: '2026-10-09' });
  const pfOct = await proformas.create(owner, {
    projectId,
    stage: 'Advance 2',
    pfDate: '2026-10-10',
    dueDate: '2026-10-20',
    lines: [{ description: 'Advance 2', qtyMilli: 1000, rate: 1_00_000_00 }],
  });
  await receipts.record(owner, {
    proformaId: pfOct.id,
    receiptDate: '2026-10-11',
    amount: 1_18_000_00,
    mode: 'upi',
    reference: 'U-9',
  });
  // Purchases: an eligible bill (₹40,000 + 18%) and a blocked-credit bill, both in October.
  const vendor = await contacts.create(owner, {
    type: 'vendor',
    name: 'GST Vendor',
    stateCode: '33',
    gstin: gstin('33ABCDE1234F1Z'),
  });
  const bill = await bills.create(owner, {
    vendorId: vendor,
    projectId,
    billNo: 'V-1',
    billDate: '2026-10-05',
    dueDate: '2026-10-10',
    category: 'material',
    taxable: 40_000_00,
    gstRate: 18,
  });
  await bills.create(owner, {
    vendorId: vendor,
    projectId,
    billNo: 'V-2',
    billDate: '2026-10-06',
    dueDate: '2027-03-31',
    category: 'misc',
    taxable: 1_000_00,
    gstRate: 18,
    itcEligible: false,
  });
  await payments.record(owner, {
    billId: bill.id,
    payDate: '2026-10-12',
    amount: 10_000_00,
    mode: 'bank',
    reference: 'UTR-P',
  });
  await payments.record(manager, {
    billId: bill.id,
    payDate: '2026-10-12',
    amount: 5_000_00,
    mode: 'cash',
  });
});
afterAll(closePools);

describe('GST returns for October 2026 (FR-15)', () => {
  it('3.1(a) is invoices less credit notes; 4(A)(5) is eligible ITC only; due on the 20th', async () => {
    const m = await gst.month(owner, '2026-10');
    expect(m.dueDate).toBe('2026-11-20');
    // ₹1,00,000 + ₹10,000 (cancelled) + ₹50,000 (converted proforma) invoiced; ₹10,000 credited.
    expect(m.invoicesTotal.taxable).toBe(1_60_000_00);
    expect(m.creditNotesTotal.taxable).toBe(10_000_00);
    expect(m.outward).toEqual({
      taxable: 1_50_000_00,
      tax: { igst: 0, cgst: 13_500_00, sgst: 13_500_00 },
    });
    expect(m.itc).toEqual({ igst: 0, cgst: 3_600_00, sgst: 3_600_00 });
    expect(m.itcRegister.map((b) => [b.billNo, b.eligible])).toEqual([
      ['V-1', true],
      ['V-2', false],
    ]);
  });

  it('11A is October’s uninvoiced advance; 11B is September’s advance invoiced in October', async () => {
    const m = await gst.month(owner, '2026-10');
    expect(m.advances.received.map((a) => a.amount)).toEqual([1_18_000_00]);
    expect(m.advancesReceived.tax).toEqual({ igst: 0, cgst: 9_000_00, sgst: 9_000_00 });
    expect(m.advances.adjusted.map((a) => a.amount)).toEqual([59_000_00]);
    expect(m.advancesAdjusted.tax).toEqual({ igst: 0, cgst: 4_500_00, sgst: 4_500_00 });
    // Liability = outward 13,500 + 11A 9,000 − 11B 4,500 per head; ITC 3,600 per head is set off.
    expect(m.liability).toEqual({ igst: 0, cgst: 18_000_00, sgst: 18_000_00 });
    expect(m.setOff.cash).toEqual({ igst: 0, cgst: 14_400_00, sgst: 14_400_00 });
    const sep = await gst.month(owner, '2026-09');
    expect(sep.advances.received.map((a) => a.amount)).toEqual([59_000_00]);
  });

  it('GSTR-1 JSON has the B2B invoice, the credit note and the HSN summary; the download is audited', async () => {
    const j = await gst.gstr1Json(owner, '2026-10');
    expect(j.fp).toBe('102026');
    expect(j.b2b[0]?.inv.map((i) => i.inum)).toHaveLength(3);
    expect(j.cdnr[0]?.nt).toHaveLength(1);
    expect(j.hsn.data[0]).toMatchObject({ hsn_sc: '9954', txval: 150000 });
    const { rows } = await superPool.query(
      `SELECT 1 FROM audit_log WHERE company_id = $1 AND entity = 'gstr1' AND action = 'export'`,
      [f.companyId],
    );
    expect(rows).toHaveLength(1);
  });

  it('is company-wide: GST rights and access to all projects are required', async () => {
    const asst = actorFor(f, await makeUser(f.companyId, 'asstmgr'), 'asstmgr');
    await expect(gst.month(asst, '2026-10')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const scopedAdmin = actorFor(f, await makeUser(f.companyId, 'admin'), 'admin', [projectId]);
    await expect(gst.month(scopedAdmin, '2026-10')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(gst.month(owner, '2026-13')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('cash, bank & UPI (FR-13)', () => {
  it('registers run a balance from the opening; ticks count as matched', async () => {
    await banking.setOpening(owner, { code: '1010', amount: 5_00_000_00, asOf: '2026-04-01' });
    // Replacing the opening balance reverses the first one.
    await banking.setOpening(owner, { code: '1010', amount: 2_00_000_00, asOf: '2026-04-01' });
    const reg = await banking.register(owner, '1010', { from: '2026-04-01', to: '2026-10-31' });
    const last = reg.lines[reg.lines.length - 1]!;
    // 2,00,000 opening + 18,000 receipt − 10,000 vendor payment.
    expect(reg.closing).toBe(2_08_000_00);
    expect(last.balance).toBe(reg.closing);
    const receiptLine = reg.lines.find((l) => l.sourceType === 'receipt')!;
    await banking.setMatched(owner, receiptLine.lineId, true);
    const cards = await banking.accounts(owner);
    const bank = cards.find((x) => x.code === '1010')!;
    expect(bank.balance).toBe(2_08_000_00);
    const after = await banking.register(owner, '1010', { from: '2026-04-01', to: '2026-10-31' });
    expect(after.unmatched).toBe(reg.unmatched - 1);
    await banking.setMatched(owner, receiptLine.lineId, false);
    // October only: the opening is carried in.
    const oct = await banking.register(owner, '1010', { from: '2026-10-01', to: '2026-10-31' });
    expect(oct.opening).toBe(2_00_000_00);
  });

  it('only the Owner sets opening balances; a manager has no banking', async () => {
    await expect(
      banking.setOpening(manager, { code: '1000', amount: 1_00, asOf: '2026-04-01' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(banking.accounts(manager)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('spending by staff splits approved spends by paid-by and mode; pending ones are left out', async () => {
    const rows = await banking.spendByStaff(owner, { from: '2026-10-01', to: '2026-10-31' });
    const unspecified = rows.find((r) => r.paidBy === 'Unspecified');
    // The owner's ₹10,000 bank payment counts; the manager's pending ₹5,000 cash does not.
    expect(unspecified).toMatchObject({ bank: 10_000_00, cash: 0 });
  });
});

describe('outstanding (FR-14)', () => {
  it('receivables exclude proformas; payables count only approved payments; ageing by due date', async () => {
    const rec = await outstanding.receivables(owner);
    const inv = rec.rows.find((r) => r.id === b2bInvoice)!;
    expect(inv.balance).toBe(1_18_000_00 - 18_000_00);
    expect(rec.rows.some((r) => r.number.startsWith('PI/'))).toBe(false);
    const pay = await outstanding.payables(owner);
    const v1 = pay.rows.find((r) => r.number === 'V-1')!;
    // ₹47,200 bill, ₹10,000 approved; the pending ₹5,000 is not paid yet. Due 10 Oct: overdue.
    expect(v1.balance).toBe(37_200_00);
    expect(v1.daysOverdue).toBeGreaterThan(0);
    expect(v1.bucket).not.toBe('current');
    expect(Object.values(pay.buckets).reduce((s, x) => s + x, 0)).toBe(pay.total);
  });
});

describe('reports (FR-16)', () => {
  it('project revenue and cost come from the journal; profit is hidden without the pnl right', async () => {
    const own = await reports.projectIncomeExpense(owner);
    const p = own.find((r) => r.projectId === projectId)!;
    // Revenue 1,50,000 (net of the credit note); cost 40,000 + blocked bill 1,180 (GST is cost).
    expect(p.revenue).toBe(1_50_000_00);
    expect(p.cost).toBe(41_180_00);
    expect(p.profit).toBe(1_08_820_00);
    const mgr = await reports.projectIncomeExpense(manager);
    const pm = mgr.find((r) => r.projectId === projectId)!;
    expect(pm).not.toHaveProperty('profit');
    expect(pm).not.toHaveProperty('margin');
    await expect(reports.projectPnl(manager)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('category pivot and trial balance (debits equal credits); trial balance needs pnl', async () => {
    const pivot = await reports.categoryPivot(owner);
    const row = pivot.projects.find((r) => r.projectId === projectId)!;
    expect(row.byCategory).toMatchObject({ material: 40_000_00, misc: 1_180_00 });
    const tb = await reports.trialBalance(owner);
    expect(tb.balanced).toBe(true);
    expect(tb.debit).toBe(tb.credit);
    await expect(reports.trialBalance(manager)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
