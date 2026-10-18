import jpeg from 'jpeg-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, CostCategory } from '@csd/core';
import {
  AttachmentsService,
  DashboardService,
  ExpensesService,
  InvoicesService,
  MemoryBlobStore,
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

const dashboard = new DashboardService(appPool);
const invoices = new InvoicesService(appPool);
const receipts = new ReceiptsService(appPool);
const expenses = new ExpensesService(appPool);
const files = new AttachmentsService(appPool, new MemoryBlobStore());
const JPEG = Buffer.from(
  jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 200), width: 8, height: 8 }, 90).data,
);

let f: Fixture;
let owner: Actor;
let admin: Actor;
let manager: Actor;
let a: { clientId: string; projectId: string };
let b: { clientId: string; projectId: string };

/** An expense on 8 Oct, entered by `by` (posted at once for the Owner, Pending otherwise). */
async function spend(
  by: Actor,
  projectId: string,
  amount: number,
  category: CostCategory = 'material',
) {
  return expenses.create(by, {
    projectId,
    txnDate: '2026-10-08',
    amount,
    particulars: 'Plywood',
    category,
    paidBy: 'Admin',
    mode: 'bank',
    paidTo: 'Sri Murugan Traders',
    attachmentId: (await files.upload(by, JPEG)).id,
  });
}

beforeAll(async () => {
  f = await makeCompany('Dashboard Co');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
  admin = actorFor(f, await makeUser(f.companyId, 'admin'), 'admin');
  // Budget 7,50,000 each (sales-helpers). A: 1,18,000 invoiced, 50,000 received, 6,50,000 spent (86%).
  a = await clientProject(owner);
  b = await clientProject(owner);
  manager = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager', [a.projectId]);
  const inv = await invoices.create(owner, invoiceInput(a.projectId));
  await receipts.record(owner, {
    invoiceId: inv.id,
    receiptDate: '2026-10-12',
    amount: 50_000_00,
    mode: 'bank',
    reference: 'UTR-D1',
  });
  await spend(owner, a.projectId, 6_50_000_00);
  // B: over budget (8,00,000 of 7,50,000), and a manager's pending expense that must not count.
  await spend(owner, b.projectId, 8_00_000_00, 'labour');
  await spend(actorFor(f, manager.userId, 'manager'), b.projectId, 99_000_00);
});
afterAll(closePools);

describe('dashboard (README §2)', () => {
  it('the Owner sees KPIs, alerts, projects with net value, spend by category and ageing', async () => {
    const d = await dashboard.summary(owner);
    const inv = (await invoices.list(owner)).find((i) => i.projectId === a.projectId)!;
    expect(d.kpis.receivables).toBe(inv.total - 50_000_00);
    expect(d.kpis.payables).toBe(0);
    // Cash and bank: 50,000 received less 14,50,000 paid out by bank.
    expect(d.kpis.cashAndBank).toBe(50_000_00 - 14_50_000_00);
    expect(d.kpis.waitingApproval).toBe(1);
    expect(d.kpis.collectedThisYear).toBeNull();
    const rowA = d.projects.find((p) => p.projectId === a.projectId)!;
    expect(rowA).toMatchObject({
      invoiceValue: inv.total,
      income: 50_000_00,
      expense: 6_50_000_00,
      net: 50_000_00 - 6_50_000_00,
      budgetUsedBp: 8_667,
    });
    // The pending 99,000 is not spent yet.
    expect(d.projects.find((p) => p.projectId === b.projectId)!.expense).toBe(8_00_000_00);
    expect(d.spendByCategory).toMatchObject({ material: 6_50_000_00, labour: 8_00_000_00 });
    expect(d.ageing.current).toBe(d.kpis.receivables);
    expect(d.alerts.map((x) => [x.kind, x.tone])).toEqual([
      ['approvals', 'amber'],
      ['budget', 'amber'],
      ['budget', 'red'],
    ]);
  });

  it('without banking or pnl there is no cash figure and no net value; non-approvers see collections', async () => {
    const d = await dashboard.summary(admin);
    expect(d.kpis.cashAndBank).not.toBeNull(); // admin has banking by default
    expect(d.kpis.waitingApproval).toBeNull();
    expect(d.kpis.collectedThisYear).toBe(50_000_00);
    expect(d.projects.every((p) => p.net === undefined)).toBe(true);
    expect(d.alerts.some((x) => x.kind === 'approvals')).toBe(false);
  });

  it('a scoped manager sees only their projects, and no company-wide cash figure', async () => {
    const d = await dashboard.summary(manager);
    expect(d.projects.map((p) => p.projectId)).toEqual([a.projectId]);
    expect(d.kpis.cashAndBank).toBeNull();
    expect(d.spendByCategory.labour).toBe(0);
  });

  it('users without the dashboard right are refused', async () => {
    const site = actorFor(f, await makeUser(f.companyId, 'site'), 'site', [a.projectId]);
    await expect(dashboard.summary(site)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('the Owner gets one notification per budget level, however often it runs', async () => {
    await dashboard.summary(owner);
    await dashboard.summary(owner);
    const { rows } = await superPool.query<{ key: string }>(
      `SELECT key FROM notification WHERE user_id = $1 AND type = 'budget' ORDER BY key`,
      [f.ownerId],
    );
    expect(rows.map((r) => r.key).sort()).toEqual(
      [`budget:${a.projectId}:85`, `budget:${b.projectId}:over`].sort(),
    );
  });
});
