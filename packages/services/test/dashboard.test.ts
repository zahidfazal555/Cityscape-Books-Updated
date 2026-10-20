import jpeg from 'jpeg-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn, type Actor, type CostCategory } from '@csd/core';
import {
  AttachmentsService,
  BankingService,
  DashboardService,
  ExpensesService,
  InvoicesService,
  MemoryBlobStore,
  OutstandingService,
  ReceiptsService,
  ReportsService,
  budgetLevel,
  lastMonths,
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
import { postJournal, withTenant } from '@csd/db';

const dashboard = new DashboardService(appPool);
const invoices = new InvoicesService(appPool);
const receipts = new ReceiptsService(appPool);
const expenses = new ExpensesService(appPool);
const files = new AttachmentsService(appPool, new MemoryBlobStore());
const JPEG = Buffer.from(
  jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 200), width: 8, height: 8 }, 90).data,
);
// Everything is dated today, so the figures stay in the current year and current ageing bucket
// whenever the suite runs.
const today = todayIn();

let f: Fixture;
let owner: Actor;
let admin: Actor;
let manager: Actor;
let a: { clientId: string; projectId: string };
let b: { clientId: string; projectId: string };

/** An expense dated today, entered by `by` (posted at once for the Owner, Pending otherwise). */
async function spend(
  by: Actor,
  projectId: string,
  amount: number,
  category: CostCategory = 'material',
) {
  return expenses.create(by, {
    projectId,
    txnDate: today,
    amount,
    particulars: 'Plywood',
    category,
    paidBy: 'Admin',
    mode: 'bank',
    paidTo: 'Sri Murugan Traders',
    attachmentId: (await files.upload(by, JPEG)).id,
  });
}

const budgetKeys = async () =>
  (
    await superPool.query<{ key: string }>(
      `SELECT key FROM notification WHERE user_id = $1 AND type = 'budget' ORDER BY key`,
      [f.ownerId],
    )
  ).rows.map((r) => r.key);

beforeAll(async () => {
  f = await makeCompany('Dashboard Co');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
  admin = actorFor(f, await makeUser(f.companyId, 'admin'), 'admin');
  // Budget 7,50,000 each (sales-helpers). A: one invoice, 50,000 received, 6,50,000 spent (86%).
  a = await clientProject(owner);
  b = await clientProject(owner);
  manager = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager', [a.projectId]);
  const inv = await invoices.create(
    owner,
    invoiceInput(a.projectId, { invoiceDate: today, dueDate: addDays(today, 30) }),
  );
  await receipts.record(owner, {
    invoiceId: inv.id,
    receiptDate: today,
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
      level: 'amber',
    });
    // The pending 99,000 is not spent yet.
    expect(d.projects.find((p) => p.projectId === b.projectId)).toMatchObject({
      expense: 8_00_000_00,
      level: 'red',
    });
    expect(d.spendByCategory).toMatchObject({ material: 6_50_000_00, labour: 8_00_000_00 });
    expect(d.ageing.current).toBe(d.kpis.receivables);
    expect(d.alerts.map((x) => [x.kind, x.tone])).toEqual([
      ['approvals', 'amber'],
      ['budget', 'amber'],
      ['budget', 'red'],
    ]);
  });

  it('agrees with the Outstanding, Reports and Banking pages', async () => {
    const d = await dashboard.summary(owner);
    const outstanding = new OutstandingService(appPool);
    const rec = await outstanding.receivables(owner);
    expect(d.kpis.receivables).toBe(rec.total);
    expect(d.ageing).toEqual(rec.buckets);
    expect(d.kpis.payables).toBe((await outstanding.payables(owner)).total);
    expect(d.spendByCategory).toEqual(
      (await new ReportsService(appPool).categoryPivot(owner)).totals,
    );
    const accounts = await new BankingService(appPool).accounts(owner);
    expect(d.kpis.cashAndBank).toBe(accounts.reduce((s, x) => s + x.balance, 0));
  });

  it('non-approvers see collections this year and no net value; admin keeps the cash figure', async () => {
    const d = await dashboard.summary(admin);
    expect(d.kpis.cashAndBank).not.toBeNull();
    expect(d.kpis.waitingApproval).toBeNull();
    expect(d.kpis.collectedThisYear).toBe(50_000_00);
    expect(d.projects.every((p) => p.net === undefined)).toBe(true);
    expect(d.alerts.some((x) => x.kind === 'approvals')).toBe(false);
  });

  it('without the banking right there is no cash figure, even with all projects', async () => {
    const pm = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager');
    const d = await dashboard.summary(pm);
    expect(d.projects.map((p) => p.projectId)).toEqual(
      expect.arrayContaining([a.projectId, b.projectId]),
    );
    expect(d.kpis.cashAndBank).toBeNull();
  });

  it('without the projects right there are no project rows or budget alerts (BUG-200)', async () => {
    const noProjects = { ...admin, rights: { ...admin.rights, projects: 'none' as const } };
    const d = await dashboard.summary(noProjects);
    expect(d.projects).toEqual([]);
    expect(d.alerts).toEqual([]);
    expect(d.kpis.receivables).toBeGreaterThan(0);
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
});

describe('spend drill-down (dashboard slices)', () => {
  it('a category opens into its projects and entries, adding up to the dashboard slice', async () => {
    const summary = await dashboard.summary(owner);
    const d = await dashboard.spend(owner, ['material']);
    expect(d.total).toBe(summary.spendByCategory.material);
    expect(d.byProject.map((p) => [p.projectId, p.amount])).toEqual([[a.projectId, 6_50_000_00]]);
    expect(d.entries).toHaveLength(1);
    expect(d.entries[0]).toMatchObject({
      category: 'material',
      projectId: a.projectId,
      date: today,
    });
    expect(d.truncated).toBe(false);
    // Several categories at once ("Other categories") are broken down per category.
    const both = await dashboard.spend(owner, ['material', 'labour']);
    expect(both.byCategory).toEqual([
      { category: 'material', amount: 6_50_000_00 },
      { category: 'labour', amount: 8_00_000_00 },
    ]);
    expect(both.byProject[0]?.projectId).toBe(b.projectId);
  });

  it('follows project scope, and hides who was paid wages from users without payroll', async () => {
    expect((await dashboard.spend(manager, ['labour'])).total).toBe(0);
    await withTenant(appPool, { companyId: f.companyId, userId: f.ownerId }, (c) =>
      postJournal(c, {
        txnDate: today,
        sourceType: 'wage_payment',
        narration: 'Wages to Ravi K',
        lines: [
          { accountCode: '5010', debit: 1_000_00, projectId: a.projectId },
          { accountCode: '1000', credit: 1_000_00 },
        ],
      }),
    );
    const scoped = await dashboard.spend(manager, ['labour']);
    expect(scoped.entries.map((e) => e.particulars)).toEqual(['Labour payment']);
    const full = await dashboard.spend(owner, ['labour']);
    expect(full.entries.map((e) => e.particulars)).toContain('Wages to Ravi K');
    const site = actorFor(f, await makeUser(f.companyId, 'site'), 'site', [a.projectId]);
    await expect(dashboard.spend(site, ['labour'])).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('project charts', () => {
  it('a project shows its own spend split, budget, billing and this month in the trend', async () => {
    const d = await dashboard.project(owner, a.projectId);
    expect(d.spendByCategory.material).toBe(6_50_000_00);
    expect(d.costBudget).toBe(7_50_000_00);
    expect(d.contractValue).toBe(10_00_000_00);
    expect(d.billing).toEqual({
      invoicedTaxable: 10_00_000_00,
      invoicedTotal: 11_80_000_00,
      received: 50_000_00,
    });
    expect(d.months).toHaveLength(6);
    expect(d.months[5]).toMatchObject({ month: today.slice(0, 7), invoiced: 10_00_000_00 });
    expect(d.months[5]?.spent).toBe(d.spent);
    // Drill-down from a project slice stays on that project.
    const material = await dashboard.spend(owner, ['material'], b.projectId);
    expect(material.total).toBe(0);
  });

  it('follows project scope; billing needs the invoices right', async () => {
    await expect(dashboard.project(manager, b.projectId)).rejects.toMatchObject({ status: 403 });
    const noBilling: Actor = {
      ...owner,
      role: 'admin',
      rights: { ...admin.rights, invoices: 'none' },
    };
    expect((await dashboard.project(noBilling, a.projectId)).billing).toBeNull();
  });

  it('the trend window is six calendar months ending this month', () => {
    expect(lastMonths(6, '2026-02-15')).toEqual([
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });
});

describe('budget alerts (Tech Spec §9)', () => {
  it('BUG-199: the level is decided on exact paise, never a rounded percentage', () => {
    // ₹30 over a ₹7,50,000 budget rounds to 100.00%, but it is over.
    expect(budgetLevel(7_50_030_00, 7_50_000_00)).toBe('red');
    expect(budgetLevel(7_50_000_00, 7_50_000_00)).toBe('amber');
    // Just under 85% rounds up to 85.00%, but it is not there yet.
    expect(budgetLevel(6_37_499_70, 7_50_000_00)).toBe('ok');
    expect(budgetLevel(6_37_500_00, 7_50_000_00)).toBe('amber');
    expect(budgetLevel(1_00_000_00, 0)).toBe('ok');
  });

  it('BUG-198: postings notify the Owner, once per level, without opening the dashboard', async () => {
    // The Owner's own postings in beforeAll already crossed both lines.
    expect(await budgetKeys()).toEqual(
      [`budget:${a.projectId}:85`, `budget:${b.projectId}:over`].sort(),
    );
    // Approving the manager's pending 99,000 on B does not repeat the "over" alert.
    const pending = (await expenses.pending(owner)).find((e) => e.projectId === b.projectId)!;
    await expenses.approve(owner, pending.id, { version: pending.version });
    // An approval that pushes A over 100% adds A's "over" alert.
    const c = await spend(actorFor(f, manager.userId, 'manager'), a.projectId, 1_00_001_00);
    expect(c.status).toBe('pending');
    expect(await budgetKeys()).not.toContain(`budget:${a.projectId}:over`);
    const view = await expenses.get(owner, c.id);
    await expenses.approve(owner, c.id, { version: view.version });
    expect(await budgetKeys()).toEqual(
      [
        `budget:${a.projectId}:85`,
        `budget:${a.projectId}:over`,
        `budget:${b.projectId}:over`,
      ].sort(),
    );
    // The dashboard itself writes nothing.
    await dashboard.summary(owner);
    expect((await budgetKeys()).length).toBe(3);
  });
});
