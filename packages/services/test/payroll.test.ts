import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@csd/core';
import { ApprovalsService, InventoryService, LabourService, PayrollService } from '../src/index.js';
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

const payroll = new PayrollService(appPool);
const labour = new LabourService(appPool);
const inventory = new InventoryService(appPool);
const approvals = new ApprovalsService(appPool);

let f: Fixture;
let owner: Actor;
let admin: Actor;
let manager: Actor;
let projectId: string;
let otherProject: string;

const pay = { mode: 'bank' as const, reference: 'UTR-PAY-1' };

beforeAll(async () => {
  f = await makeCompany('Payroll Co');
  await superPool.query(`INSERT INTO number_series VALUES ($1, 'project', '-', 2)`, [f.companyId]);
  owner = actorFor(f, f.ownerId, 'owner');
  admin = actorFor(f, await makeUser(f.companyId, 'admin'), 'admin');
  manager = actorFor(f, await makeUser(f.companyId, 'manager'), 'manager');
  ({ projectId } = await clientProject(owner));
  ({ projectId: otherProject } = await clientProject(owner));
});

afterAll(closePools);

const balanced = async () => {
  const tb = await trialBalance(f.companyId);
  expect(tb.dr).toBe(tb.cr);
};

describe('monthly staff and payroll runs (FR-17.1, H2, SPEC-FIXES C2)', () => {
  let shiva: string;
  let designer: string;

  it('the owner adds staff with a salary; an admin’s salary waits for the owner', async () => {
    ({ id: shiva } = await payroll.createEmployee(owner, {
      kind: 'salaried',
      name: 'Shiva',
      roleTitle: 'Project Manager',
      rate: 48_000_00,
      ptHalfYear: 1_250_00,
      recoveryInstalment: 2_000_00,
    }));
    ({ id: designer } = await payroll.createEmployee(admin, {
      kind: 'salaried',
      name: 'Interior Designer',
      roleTitle: 'Design',
      rate: 42_000_00,
      monthlyTds: 1_800_00,
    }));
    const staff = await payroll.employees(owner, 'salaried');
    const d = staff.find((e) => e.id === designer)!;
    expect(d.monthlyGross).toBe(0);
    expect(d.pendingRate?.value).toBe(42_000_00);
    const q = await approvals.queue(owner);
    expect(q.rateChanges.map((r) => r.targetName)).toContain('Interior Designer');
    await payroll.approveRate(owner, d.pendingRate!.id);
    expect(
      (await payroll.employees(owner, 'salaried')).find((e) => e.id === designer)!.monthlyGross,
    ).toBe(42_000_00);
  });

  it('a second pending change to the same salary is refused; the owner’s direct change replaces it', async () => {
    expect(await payroll.requestRate(admin, shiva, { value: 50_000_00 })).toEqual({
      status: 'pending',
    });
    await expect(payroll.requestRate(admin, shiva, { value: 51_000_00 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await payroll.requestRate(owner, shiva, { value: 49_000_00 })).toEqual({
      status: 'approved',
    });
    const s = (await payroll.employees(owner, 'salaried')).find((e) => e.id === shiva)!;
    expect(s.monthlyGross).toBe(49_000_00);
    expect(s.pendingRate).toBeNull();
  });

  it('staff payroll is hidden from users without the right or with a project scope', async () => {
    await expect(payroll.employees(manager, 'salaried')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const scoped = actorFor(f, admin.userId, 'admin', [projectId]);
    await expect(payroll.employees(scoped, 'salaried')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(payroll.approveRate(admin, shiva)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an advance is recovered through payroll; September deducts professional tax', async () => {
    const adv = await payroll.recordAdvance(admin, {
      employeeId: shiva,
      advDate: '2026-08-20',
      amount: 5_000_00,
      mode: 'cash',
    });
    expect(adv.status).toBe('pending');
    // A pending advance is not recovered.
    expect(
      (await payroll.preview(owner, '2026-09')).find((l) => l.employeeId === shiva)!.recovery,
    ).toBe(0);
    await payroll.approveAdvance(owner, adv.id);
    expect(await accountBalance(f.companyId, '1300')).toBe(5_000_00);
    const sep = await payroll.preview(owner, '2026-09');
    expect(sep.find((l) => l.employeeId === shiva)).toMatchObject({
      gross: 49_000_00,
      pt: 1_250_00,
      recovery: 2_000_00,
      net: 45_750_00,
    });
    expect(sep.find((l) => l.employeeId === designer)).toMatchObject({ tds: 1_800_00, pt: 0 });
  });

  it('an admin’s run is pending and posts nothing; the owner approves it into the books', async () => {
    const run = await payroll.process(admin, { period: '2026-09', payDate: '2026-09-30', ...pay });
    expect(run.status).toBe('pending');
    await expect(
      payroll.process(admin, { period: '2026-09', payDate: '2026-09-30', ...pay }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await accountBalance(f.companyId, '6000')).toBe(0);
    const q = await approvals.queue(owner);
    expect(q.payroll.runs.map((r) => r.id)).toContain(run.id);
    await payroll.approveRun(owner, run.id);
    expect(await accountBalance(f.companyId, '6000')).toBe(91_000_00);
    expect(await accountBalance(f.companyId, '2320')).toBe(-1_250_00);
    expect(await accountBalance(f.companyId, '2310')).toBe(-1_800_00);
    expect(await accountBalance(f.companyId, '1300')).toBe(3_000_00);
    await balanced();
    const detail = await payroll.run(owner, run.id);
    expect(detail.lines).toHaveLength(2);
    expect(detail.totals.gross).toBe(
      detail.totals.tds + detail.totals.pt + detail.totals.recovery + detail.totals.net,
    );
  });

  it('October has no PT; recovery stops at what is owed; future months and early pay dates are refused', async () => {
    const oct = await payroll.preview(owner, '2026-10');
    expect(oct.find((l) => l.employeeId === shiva)).toMatchObject({ pt: 0, recovery: 2_000_00 });
    await expect(
      payroll.process(owner, { period: '2099-01', payDate: '2026-10-01', ...pay }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      payroll.process(owner, { period: '2026-10', payDate: '2026-09-30', ...pay }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('an advance already recovered cannot be deleted; a rejected run releases its recoveries', async () => {
    const [adv] = await payroll.advances(owner, { status: 'approved' });
    await expect(payroll.removeAdvance(owner, adv!.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    const run = await payroll.process(admin, { period: '2026-10', payDate: '2026-10-15', ...pay });
    expect(
      (await payroll.employees(owner, 'salaried')).find((e) => e.id === shiva)!.advanceOutstanding,
    ).toBe(1_000_00);
    await payroll.rejectRun(owner, run.id, { reason: 'Wrong pay date' });
    expect(
      (await payroll.employees(owner, 'salaried')).find((e) => e.id === shiva)!.advanceOutstanding,
    ).toBe(3_000_00);
  });

  it('only the owner reverses an approved run; the reversal is dated on the run and balances', async () => {
    const run = await payroll.process(owner, { period: '2026-10', payDate: '2026-10-16', ...pay });
    expect(run.status).toBe('approved');
    await expect(payroll.removeRun(admin, run.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await setLock(f.companyId, '2026-10-16');
    try {
      await expect(payroll.removeRun(owner, run.id)).rejects.toMatchObject({
        code: 'PERIOD_LOCKED',
      });
    } finally {
      await setLock(f.companyId, null);
    }
    await payroll.removeRun(owner, run.id);
    expect(await accountBalance(f.companyId, '6000')).toBe(91_000_00);
    await balanced();
  });
});

describe('daily-wage labour (FR-17.2)', () => {
  let anbu: string;

  it('a worker’s rate set by an admin waits for the owner; until then attendance is refused', async () => {
    ({ id: anbu } = await payroll.createEmployee(admin, {
      kind: 'daily',
      name: 'Anbalagan',
      roleTitle: 'Electrician',
      projectId,
      rate: 900_00,
    }));
    await expect(labour.markAttendance(admin, anbu)).rejects.toMatchObject({ code: 'CONFLICT' });
    const [rc] = (await approvals.queue(owner)).rateChanges.filter((r) => r.targetId === anbu);
    await payroll.approveRate(owner, rc!.id);
  });

  it('+1 marks a day at the approved rate, once per day; half days count', async () => {
    const w = await labour.markAttendance(admin, anbu);
    expect(w).toMatchObject({ tenths: 10, earned: 900_00, balance: 900_00, markedToday: true });
    await expect(labour.markAttendance(admin, anbu)).rejects.toMatchObject({ code: 'CONFLICT' });
    const w2 = await labour.markAttendance(admin, anbu, { workDate: '2026-10-01', tenths: 5 });
    expect(w2.earned).toBe(1_350_00);
    await expect(
      labour.markAttendance(admin, anbu, { workDate: '2099-01-01' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('a later rate change leaves earned wages alone', async () => {
    await payroll.requestRate(owner, anbu, { value: 1_000_00 });
    expect((await labour.worker(owner, anbu)).earned).toBe(1_350_00);
  });

  it('wages are paid up to the balance, pending for an admin, posted to project labour by the owner', async () => {
    await expect(
      labour.payWages(admin, {
        employeeId: anbu,
        payDate: '2026-10-16',
        amount: 1_350_01,
        mode: 'cash',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const wp = await labour.payWages(admin, {
      employeeId: anbu,
      payDate: '2026-10-16',
      amount: 1_000_00,
      mode: 'cash',
    });
    expect(wp.status).toBe('pending');
    expect((await labour.worker(owner, anbu)).balance).toBe(350_00);
    // A pending payment holds the balance: paying more than what is left is refused.
    await expect(
      labour.payWages(owner, {
        employeeId: anbu,
        payDate: '2026-10-16',
        amount: 400_00,
        mode: 'cash',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await approvals.queue(owner)).payroll.payments.map((p) => p.id)).toContain(wp.id);
    await labour.approvePayment(owner, 'wage', wp.id);
    expect(await accountBalance(f.companyId, '5010')).toBe(1_000_00);
    await balanced();
  });

  it('a paid day cannot be unmarked; a worker with unpaid wages cannot move project', async () => {
    await expect(labour.unmarkAttendance(admin, anbu, '2026-10-01')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      payroll.updateEmployee(admin, anbu, { projectId: otherProject }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await labour.payWages(owner, {
      employeeId: anbu,
      payDate: '2026-10-16',
      amount: 350_00,
      mode: 'cash',
    });
    await payroll.updateEmployee(admin, anbu, { projectId: otherProject });
    expect((await labour.worker(owner, anbu)).earned).toBe(0);
  });

  it('a user scoped to another project cannot see the worker', async () => {
    const scoped = actorFor(f, admin.userId, 'admin', [projectId]);
    await expect(labour.worker(scoped, anbu)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await labour.workers(scoped)).map((w) => w.id)).not.toContain(anbu);
  });
});

describe('contractors paid per job (FR-17.3, TDS u/s 194C)', () => {
  let job: string;

  it('a job value set by an admin waits; the owner approves it', async () => {
    ({ id: job } = await labour.createJob(admin, {
      contractor: 'Jones Gypsum Works',
      work: 'Gypsum partitions & ceiling',
      projectId,
      value: 1_20_000_00,
      tdsRate: 2,
    }));
    await expect(
      labour.payContract(owner, { jobId: job, payDate: '2026-10-16', amount: 10_000_00, ...pay }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const [rc] = (await approvals.queue(owner)).rateChanges.filter((r) => r.targetId === job);
    expect(rc?.field).toBe('job_value');
    await payroll.approveRate(owner, rc!.id);
  });

  it('pays gross to subcontract cost with 2% TDS held back, up to the job balance', async () => {
    const before5020 = await accountBalance(f.companyId, '5020');
    const tdsBefore = await accountBalance(f.companyId, '2310');
    const r = await labour.payContract(owner, {
      jobId: job,
      payDate: '2026-10-16',
      amount: 70_000_00,
      ...pay,
    });
    expect(r.status).toBe('approved');
    expect((await accountBalance(f.companyId, '5020')) - before5020).toBe(70_000_00);
    expect((await accountBalance(f.companyId, '2310')) - tdsBefore).toBe(-1_400_00);
    const j = (await labour.jobs(owner)).find((x) => x.id === job)!;
    expect(j).toMatchObject({ paid: 70_000_00, balance: 50_000_00 });
    await expect(
      labour.payContract(owner, { jobId: job, payDate: '2026-10-16', amount: 50_000_01, ...pay }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(labour.requestJobValue(owner, job, { value: 60_000_00 })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await balanced();
  });

  it('an admin’s payment is pending; rejecting it frees the balance; a closed job takes no payments', async () => {
    const r = await labour.payContract(admin, {
      jobId: job,
      payDate: '2026-10-16',
      amount: 20_000_00,
      ...pay,
    });
    expect((await labour.jobs(owner)).find((x) => x.id === job)!.balance).toBe(30_000_00);
    await labour.rejectPayment(owner, 'contract', r.id, { reason: 'Not yet due' });
    expect((await labour.jobs(owner)).find((x) => x.id === job)!.balance).toBe(50_000_00);
    await labour.updateJob(admin, job, { progress: 60, isClosed: true });
    await expect(
      labour.payContract(owner, { jobId: job, payDate: '2026-10-16', amount: 1_000_00, ...pay }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a pending entry in a locked month can still be rejected but not approved', async () => {
    await labour.updateJob(owner, job, { isClosed: false });
    const r = await labour.payContract(admin, {
      jobId: job,
      payDate: '2026-10-05',
      amount: 1_000_00,
      ...pay,
    });
    await setLock(f.companyId, '2026-10-10');
    try {
      await expect(labour.approvePayment(owner, 'contract', r.id)).rejects.toMatchObject({
        code: 'PERIOD_LOCKED',
      });
      await labour.rejectPayment(owner, 'contract', r.id, { reason: 'Locked month' });
    } finally {
      await setLock(f.companyId, null);
    }
  });
});

describe('inventory: material purchase tracking (FR-18)', () => {
  it('records purchases with an average rate and category totals, posting nothing', async () => {
    const tb = await trialBalance(f.companyId);
    await inventory.record(manager, {
      projectId,
      purchaseDate: '2026-10-12',
      item: 'Teakwood beading (imported)',
      category: 'Wood',
      unit: 'Rft',
      qtyMilli: 140_000,
      amount: 7_337_00,
      vendorName: 'Cochin Timber',
    });
    await inventory.record(manager, {
      projectId,
      purchaseDate: '2026-10-12',
      item: '18mm BWP plywood',
      category: 'Board',
      unit: 'Sheet',
      qtyMilli: 1_000,
      amount: 1_984_00,
      vendorName: 'Sri Bagavathy Ply',
    });
    const v = await inventory.list(manager, { projectId });
    expect(v.total).toBe(9_321_00);
    expect(v.byCategory[0]).toEqual({ category: 'Wood', amount: 7_337_00, count: 1 });
    expect(v.purchases.find((x) => x.item.startsWith('Teak'))!.averageRate).toBe(52_41);
    expect(await trialBalance(f.companyId)).toEqual(tb);
  });

  it('validates the category and scope; only the author or full rights remove an entry', async () => {
    await expect(
      inventory.record(manager, {
        projectId,
        purchaseDate: '2026-10-12',
        item: 'X',
        category: 'Gold' as 'Board',
        unit: 'Nos',
        qtyMilli: 1000,
        amount: 100,
        vendorName: 'V',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const scoped = actorFor(f, manager.userId, 'manager', [otherProject]);
    expect((await inventory.list(scoped)).purchases).toEqual([]);
    const [first] = (await inventory.list(owner, { projectId })).purchases;
    const other = actorFor(f, await makeUser(f.companyId, 'asstmgr'), 'asstmgr');
    await expect(inventory.remove(other, first!.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await inventory.remove(manager, first!.id);
    expect((await inventory.list(owner, { projectId })).purchases).toHaveLength(1);
    const rows = await inventory.export(owner);
    expect(rows).toHaveLength(1);
    const { rows: audit } = await superPool.query(
      `SELECT 1 FROM audit_log WHERE company_id = $1 AND entity = 'material_purchase' AND action = 'export'`,
      [f.companyId],
    );
    expect(audit).toHaveLength(1);
  });
});
