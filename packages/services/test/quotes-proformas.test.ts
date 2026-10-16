import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn, type Actor } from '@csd/core';
import {
  InvoicesService,
  ProformasService,
  ProjectsService,
  QuotationsService,
  ReceiptsService,
  type QuoteInput,
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
import { accountBalance, clientProject, setLock, trialBalance } from './sales-helpers.js';

const quotes = new QuotationsService(appPool);
const proformas = new ProformasService(appPool);
const invoices = new InvoicesService(appPool);
const receipts = new ReceiptsService(appPool);
const projects = new ProjectsService(appPool);
let f: Fixture;
let owner: Actor;
let manager: Actor;

const validTill = () => addDays(todayIn(), 30);

beforeAll(async () => {
  f = await makeCompany('Quotes Co');
  // makeCompany seeds CSD-PRJ-0001 directly; continue the series after it.
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
  manager = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager');
});
afterEach(() => setLock(f.companyId, null));
afterAll(closePools);

const quoteInput = (clientId: string, over: Partial<QuoteInput> = {}): QuoteInput => ({
  clientId,
  title: 'Office interiors, 3rd floor',
  site: 'Guindy, Chennai',
  quoteDate: '2026-10-01',
  validTill: validTill(),
  lines: [
    { description: 'False ceiling', qtyMilli: 1_200_000, unit: 'sqft', rate: 150_00, gstRate: 18 },
    {
      description: 'Modular workstations',
      sacHsn: '9403',
      qtyMilli: 20_000,
      unit: 'nos',
      rate: 25_000_00,
      gstRate: 18,
    },
  ],
  ...over,
});

/** A sent, accepted quote with its project. */
async function acceptedQuote(over: Partial<QuoteInput> = {}) {
  const { clientId } = await clientProject(owner);
  const q = await quotes.create(owner, quoteInput(clientId, over));
  await quotes.send(owner, q.id);
  const p = await quotes.accept(owner, q.id);
  return { ...q, ...p, clientId };
}

describe('UAT 1: quote → revise → accept → proforma → advance → tax invoice → paid', () => {
  it('runs end to end with balanced books and no revenue before the invoice', async () => {
    const { clientId } = await clientProject(owner);
    // ₹1,80,000 + ₹5,00,000 = ₹6,80,000 less 10% = ₹6,12,000 taxable.
    const q = await quotes.create(owner, quoteInput(clientId, { discountPct: 10 }));
    expect(q.number).toMatch(/^QT\/26-27\/\d{4}$/);
    await quotes.send(owner, q.id);

    // Revise: keeps the number, stores rev 0 in history, back to draft at rev 1.
    expect(await quotes.revise(owner, q.id)).toEqual({ revision: 1 });
    let view = await quotes.get(owner, q.id);
    expect(view).toMatchObject({ number: q.number, revision: 1, status: 'draft' });
    expect(view.revisions).toEqual([
      expect.objectContaining({ revision: 0, status: 'sent', total: view.total }),
    ]);
    await quotes.update(owner, q.id, {
      ...quoteInput(clientId, { discountPct: 10 }),
      title: 'Office interiors, 3rd floor (rev 1)',
      version: view.version,
    });
    await quotes.send(owner, q.id);
    view = await quotes.get(owner, q.id);
    expect(view.taxable).toBe(6_12_000_00);

    const revenueBefore = await accountBalance(f.companyId, '4000');
    const accepted = await quotes.accept(owner, q.id, { startDate: '2026-10-02' });
    const project = await projects.get(owner, accepted.projectId);
    expect(project).toMatchObject({
      name: 'Office interiors, 3rd floor (rev 1)',
      siteAddress: 'Guindy, Chennai',
      contractValue: 6_12_000_00,
      costBudget: 4_59_000_00,
      clientId,
    });
    expect((await quotes.get(owner, q.id)).status).toBe('accepted');

    // 30% proforma: ₹1,83,600 + 18% GST = ₹2,16,648.
    const pf = await proformas.fromQuote(owner, q.id, {
      pct: 30,
      pfDate: '2026-10-03',
      dueDate: '2026-10-10',
    });
    expect(pf.number).toMatch(/^PI\/26-27\/\d{4}$/);
    await proformas.send(owner, pf.id);
    let pv = await proformas.get(owner, pf.id);
    expect(pv).toMatchObject({ stage: 'Advance 30%', total: 2_16_648_00, status: 'overdue' });

    const advancesBefore = await accountBalance(f.companyId, '2100');
    const arBefore = await accountBalance(f.companyId, '1100');
    await receipts.record(manager, {
      proformaId: pf.id,
      receiptDate: '2026-10-05',
      amount: 1_00_000_00,
      mode: 'bank',
      reference: 'UTR-778812',
    });
    pv = await proformas.get(owner, pf.id);
    expect(pv).toMatchObject({ advances: 1_00_000_00, balance: 1_16_648_00 });
    // Held as a customer advance (liability), never receivable or revenue (FR-6.1).
    expect(await accountBalance(f.companyId, '2100')).toBe(advancesBefore - 1_00_000_00);
    expect(await accountBalance(f.companyId, '1100')).toBe(arBefore);
    expect(await accountBalance(f.companyId, '4000')).toBe(revenueBefore);

    const conv = await proformas.convert(owner, pf.id, { dueDate: addDays(todayIn(), 15) });
    expect(conv.invoiceNumber).toMatch(/^CSD\/\d{2}-\d{2}\/\d{4}$/);
    expect(conv.advancesApplied).toBe(1_00_000_00);
    const inv = await invoices.get(owner, conv.invoiceId);
    expect(inv).toMatchObject({
      total: 2_16_648_00,
      received: 1_00_000_00,
      balance: 1_16_648_00,
      status: 'partially_paid',
    });
    // One line per SAC: ceiling (9954) and workstations (9403).
    expect(inv.lines.map((l) => [l.sacHsn, l.taxable])).toEqual([
      ['9954', 48_600_00],
      ['9403', 1_35_000_00],
    ]);
    expect((await proformas.get(owner, pf.id)).status).toBe('converted');
    expect(await accountBalance(f.companyId, '2100')).toBe(advancesBefore);
    expect(await accountBalance(f.companyId, '1100')).toBe(arBefore + 1_16_648_00);
    expect(await accountBalance(f.companyId, '4000')).toBe(revenueBefore - 1_83_600_00);

    await receipts.record(manager, {
      invoiceId: conv.invoiceId,
      receiptDate: todayIn(),
      amount: 1_16_648_00,
      mode: 'upi',
      reference: 'UPI-5521',
    });
    expect((await invoices.get(owner, conv.invoiceId)).status).toBe('paid');
    expect(await accountBalance(f.companyId, '1100')).toBe(arBefore);
    const tb = await trialBalance(f.companyId);
    expect(tb.dr).toBe(tb.cr);

    const linked = await quotes.get(owner, q.id);
    expect(linked.proformas).toEqual([expect.objectContaining({ id: pf.id, status: 'converted' })]);
    expect(linked.invoices).toEqual([expect.objectContaining({ id: conv.invoiceId })]);
  });
});

describe('quotation rules', () => {
  it('a discount by a non-approver waits for the owner before the quote can be sent (H2)', async () => {
    const { clientId } = await clientProject(owner);
    const q = await quotes.create(manager, quoteInput(clientId, { discountPct: 5 }));
    expect((await quotes.get(manager, q.id)).discountApproved).toBe(false);
    await expect(quotes.send(manager, q.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(quotes.approveDiscount(manager, q.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await quotes.approveDiscount(owner, q.id);
    // Raising an approved discount needs approval again; keeping it does not.
    const v = await quotes.get(manager, q.id);
    await quotes.update(manager, q.id, {
      ...quoteInput(clientId, { discountPct: 5 }),
      version: v.version,
    });
    expect((await quotes.get(manager, q.id)).discountApproved).toBe(true);
    await quotes.update(manager, q.id, {
      ...quoteInput(clientId, { discountPct: 8 }),
      version: v.version + 1,
    });
    expect((await quotes.get(manager, q.id)).discountApproved).toBe(false);
    await quotes.approveDiscount(owner, q.id);
    await quotes.send(manager, q.id);
    expect((await quotes.get(manager, q.id)).status).toBe('sent');
  });

  it('a sent quote past valid-till shows Expired and cannot be accepted until revised', async () => {
    const { clientId } = await clientProject(owner);
    const q = await quotes.create(
      owner,
      quoteInput(clientId, { quoteDate: '2026-09-01', validTill: '2026-09-15' }),
    );
    await quotes.send(owner, q.id);
    expect((await quotes.get(owner, q.id)).status).toBe('expired');
    expect((await quotes.list(owner, { status: 'expired' })).map((x) => x.id)).toContain(q.id);
    await expect(quotes.accept(owner, q.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await quotes.revise(owner, q.id);
    expect((await quotes.get(owner, q.id)).status).toBe('draft');
  });

  it('only drafts can be deleted, and only with quotes = full (FR-5.8)', async () => {
    const { clientId } = await clientProject(owner);
    const q = await quotes.create(owner, quoteInput(clientId));
    await expect(quotes.remove(manager, q.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await quotes.send(owner, q.id);
    await expect(quotes.remove(owner, q.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await quotes.revise(owner, q.id);
    await quotes.remove(owner, q.id);
    await expect(quotes.get(owner, q.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('edits only drafts, with a version check', async () => {
    const { clientId } = await clientProject(owner);
    const q = await quotes.create(owner, quoteInput(clientId));
    await expect(
      quotes.update(owner, q.id, { ...quoteInput(clientId), version: 99 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await quotes.send(owner, q.id);
    await expect(
      quotes.update(owner, q.id, { ...quoteInput(clientId), version: 2 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('accepting a service quote links the existing project of the same client (FR-5.7)', async () => {
    const { clientId, projectId } = await clientProject(owner);
    const other = await clientProject(owner);
    const q = await quotes.create(owner, quoteInput(clientId));
    await quotes.send(owner, q.id);
    await expect(quotes.accept(owner, q.id, { projectId: other.projectId })).rejects.toMatchObject({
      code: 'VALIDATION',
      field: 'projectId',
    });
    const res = await quotes.accept(owner, q.id, { projectId });
    expect(res.projectId).toBe(projectId);
    // The linked project's contract is not overwritten.
    expect((await projects.get(owner, projectId)).contractValue).toBe(10_00_000_00);
    await expect(quotes.accept(owner, q.id, { projectId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('a tax invoice straight from the quote applies the discount to the rates (FR-5.6)', async () => {
    const q = await acceptedQuote({
      discountPct: 10,
      lines: [
        { description: 'Partition', qtyMilli: 2000, unit: 'nos', rate: 1_000_00, gstRate: 18 },
      ],
    });
    const inv = await quotes.toInvoice(owner, q.id, {
      invoiceDate: '2026-10-12',
      dueDate: addDays(todayIn(), 15),
    });
    const view = await invoices.get(owner, inv.id);
    expect(view.lines[0]).toMatchObject({ rate: 900_00, taxable: 1_800_00, discount: 0 });
    expect(view.total).toBe(2_124_00);
  });

  it('documents cannot be raised from a quote that is not accepted', async () => {
    const { clientId } = await clientProject(owner);
    const q = await quotes.create(owner, quoteInput(clientId));
    await expect(
      proformas.fromQuote(owner, q.id, { pct: 30, pfDate: '2026-10-03', dueDate: '2026-10-10' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      quotes.toInvoice(owner, q.id, { invoiceDate: '2026-10-03' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('proformas and advances', () => {
  const advance = (proformaId: string, amount: number, receiptDate = '2026-10-05') =>
    receipts.record(owner, { proformaId, receiptDate, amount, mode: 'cash' });

  it('edit and cancel are refused once an advance is received, and allowed after it is deleted (FR-6.6)', async () => {
    const q = await acceptedQuote();
    const pf = await proformas.fromQuote(owner, q.id, {
      pct: 50,
      pfDate: '2026-10-03',
      dueDate: addDays(todayIn(), 10),
    });
    const r = await advance(pf.id, 50_000_00);
    const v = await proformas.get(owner, pf.id);
    expect(v.status).toBe('partially_paid');
    await expect(
      proformas.update(owner, pf.id, {
        stage: 'Advance 50%',
        pfDate: '2026-10-03',
        dueDate: '2026-10-20',
        lines: v.lines,
        version: v.version,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(proformas.cancel(owner, pf.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await receipts.remove(owner, r.id);
    await proformas.cancel(owner, pf.id);
    expect((await proformas.get(owner, pf.id)).status).toBe('cancelled');
    await expect(advance(pf.id, 1_00)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(proformas.convert(owner, pf.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('advances cannot exceed the proforma balance, even when recorded concurrently', async () => {
    const { projectId } = await clientProject(owner);
    const pf = await proformas.create(owner, {
      projectId,
      stage: 'Mobilisation',
      pfDate: '2026-10-03',
      dueDate: '2026-10-10',
      lines: [{ description: 'Mobilisation advance', qtyMilli: 1000, rate: 1_00_000_00 }],
    });
    // ₹1,18,000 total; two concurrent ₹70,000 advances: exactly one succeeds.
    const results = await Promise.allSettled([
      advance(pf.id, 70_000_00),
      advance(pf.id, 70_000_00),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(advance(pf.id, 48_000_01)).rejects.toMatchObject({
      code: 'VALIDATION',
      field: 'amount',
    });
    await advance(pf.id, 48_000_00);
    expect((await proformas.get(owner, pf.id)).status).toBe('paid');
  });

  it('a converted proforma takes no more advances, and an applied advance cannot be deleted', async () => {
    const { projectId } = await clientProject(owner);
    const pf = await proformas.create(owner, {
      projectId,
      stage: 'Advance',
      pfDate: '2026-10-03',
      dueDate: '2026-10-10',
      lines: [{ description: 'Advance', qtyMilli: 1000, rate: 10_000_00 }],
    });
    const r = await advance(pf.id, 11_800_00);
    const conv = await proformas.convert(owner, pf.id, { invoiceDate: '2026-10-12' });
    expect((await invoices.get(owner, conv.invoiceId)).status).toBe('paid');
    await expect(advance(pf.id, 1_00)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(receipts.remove(owner, r.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(proformas.convert(owner, pf.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    // The invoice lists the advance as received.
    expect((await invoices.get(owner, conv.invoiceId)).receipts).toEqual([
      expect.objectContaining({ id: r.id, amount: 11_800_00 }),
    ]);
    const tb = await trialBalance(f.companyId);
    expect(tb.dr).toBe(tb.cr);
  });

  it('an advance received in a now-locked month is still applied when converting in an open month', async () => {
    const { projectId } = await clientProject(owner);
    const pf = await proformas.create(owner, {
      projectId,
      stage: 'Advance',
      pfDate: '2026-10-01',
      dueDate: '2026-10-10',
      lines: [{ description: 'Advance', qtyMilli: 1000, rate: 10_000_00 }],
    });
    await advance(pf.id, 5_000_00, '2026-10-02');
    await setLock(f.companyId, '2026-10-05');
    const conv = await proformas.convert(owner, pf.id, { invoiceDate: '2026-10-12' });
    expect((await invoices.get(owner, conv.invoiceId)).received).toBe(5_000_00);
    // Other changes to the locked receipt's allocation stay blocked.
    await expect(
      superPool.query(`UPDATE receipt_allocation SET amount = amount + 1 WHERE proforma_id = $1`, [
        pf.id,
      ]),
    ).rejects.toMatchObject({ code: 'CB423' });
  });

  it('conversion is refused into a locked period', async () => {
    const { projectId } = await clientProject(owner);
    const pf = await proformas.create(owner, {
      projectId,
      stage: 'Advance',
      pfDate: '2026-10-01',
      dueDate: '2026-10-10',
      lines: [{ description: 'Advance', qtyMilli: 1000, rate: 10_000_00 }],
    });
    await setLock(f.companyId, '2026-10-05');
    await expect(
      proformas.convert(owner, pf.id, { invoiceDate: '2026-10-04' }),
    ).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    expect((await proformas.get(owner, pf.id)).status).toBe('draft');
  });

  it('splits a mixed-rate quote into one proforma line per GST rate', async () => {
    const q = await acceptedQuote({
      lines: [
        { description: 'Civil work', qtyMilli: 1000, unit: 'lot', rate: 1_00_000_00, gstRate: 18 },
        { description: 'Furniture', sacHsn: '9403', qtyMilli: 1000, rate: 50_000_00, gstRate: 12 },
      ],
    });
    const pf = await proformas.fromQuote(owner, q.id, {
      pct: 40,
      pfDate: '2026-10-03',
      dueDate: '2026-10-10',
    });
    const v = await proformas.get(owner, pf.id);
    expect(v.lines.map((l) => [l.gstRate, l.rate])).toEqual([
      [18, 40_000_00],
      [12, 20_000_00],
    ]);
    expect(v.total).toBe(40_000_00 + 7_200_00 + 20_000_00 + 2_400_00);
  });

  it('scoped users do not see proformas outside their projects', async () => {
    const { projectId } = await clientProject(owner);
    const pf = await proformas.create(owner, {
      projectId,
      stage: 'Advance',
      pfDate: '2026-10-03',
      dueDate: '2026-10-10',
      lines: [{ description: 'Advance', qtyMilli: 1000, rate: 1_000_00 }],
    });
    const scoped = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager', []);
    await expect(proformas.get(scoped, pf.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await proformas.list(scoped)).map((p) => p.id)).not.toContain(pf.id);
    await expect(
      receipts.record(scoped, {
        proformaId: pf.id,
        receiptDate: '2026-10-05',
        amount: 1_00,
        mode: 'cash',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a receipt names exactly one document', async () => {
    await expect(
      receipts.record(owner, { receiptDate: '2026-10-05', amount: 1_00, mode: 'cash' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
