import { randomUUID } from 'node:crypto';
import {
  DomainError,
  assertApprover,
  assertId,
  assertNotLocked,
  assertPeriod,
  authorize,
  can,
  fromDecimalString,
  monthRange,
  payslipFor,
  projectScope,
  requiresApproval,
  toDecimalString,
  todayIn,
  type Actor,
  type IsoDate,
  type Paise,
  type PaymentMode,
  type Payslip,
} from '@csd/core';
import { postJournal, withTenant, writeAudit, type JournalLineInput } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import {
  ENTRY,
  REFERENCE_MESSAGE,
  accountFor,
  amountSchema,
  assertAllProjects,
  assertPending,
  dateNotFuture,
  decision,
  lockEntry,
  markApproved,
  markRejected,
  needsReference,
  paidSchema,
  payrollLock,
  rejectSchema,
  removeEntry,
  type EntryStatus,
} from './money-entries.js';
import { companyRow, parse, tenantOf as ctx } from './validation.js';

const p = fromDecimalString;
const d = toDecimalString;
const paise = z.number().int('Amounts must be in paise.').min(0, 'Amounts cannot be negative.');

const employeeSchema = z
  .object({
    kind: z.enum(['salaried', 'daily']),
    name: z.string().trim().min(1, 'Enter the name.').max(120),
    roleTitle: z.string().trim().min(1, 'Enter the designation or trade.').max(80),
    projectId: z.string().uuid('Choose a project.').nullable().optional(),
    /** Monthly gross for staff, daily rate for workers. */
    rate: paise,
    monthlyTds: paise.default(0),
    ptHalfYear: paise.default(0),
    recoveryInstalment: paise.default(0),
  })
  .refine((e) => e.kind === 'salaried' || !!e.projectId, {
    message: 'Choose the project the worker is on.',
    path: ['projectId'],
  });
const employeeUpdate = z.object({
  name: z.string().trim().min(1, 'Enter the name.').max(120).optional(),
  roleTitle: z.string().trim().min(1, 'Enter the designation or trade.').max(80).optional(),
  projectId: z.string().uuid('Choose a project.').optional(),
  monthlyTds: paise.optional(),
  ptHalfYear: paise.optional(),
  recoveryInstalment: paise.optional(),
  isActive: z.boolean().optional(),
});
const rateSchema = z.object({ value: paise });
const advanceSchema = z
  .object({
    employeeId: z.string().uuid('Choose the employee.'),
    advDate: dateNotFuture('advDate'),
    amount: amountSchema,
    ...paidSchema,
  })
  .refine(needsReference, REFERENCE_MESSAGE);
const runSchema = z
  .object({
    period: z.string().refine((s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s), 'Pick a month.'),
    payDate: dateNotFuture('payDate'),
    ...paidSchema,
  })
  .refine(needsReference, REFERENCE_MESSAGE)
  .refine((r) => r.period <= todayIn().slice(0, 7), {
    message: 'A month that has not started cannot be processed.',
    path: ['period'],
  })
  .refine((r) => r.payDate >= `${r.period}-01`, {
    message: 'Salaries are paid on or after the start of the month.',
    path: ['payDate'],
  });

export type EmployeeInput = z.input<typeof employeeSchema>;
export type EmployeeUpdate = z.input<typeof employeeUpdate>;
export type AdvanceInput = z.input<typeof advanceSchema>;
export type RunInput = z.input<typeof runSchema>;
export type RateField = 'monthly_gross' | 'daily_rate' | 'job_value';

export interface Employee {
  id: string;
  kind: 'salaried' | 'daily';
  name: string;
  roleTitle: string;
  projectId: string | null;
  projectCode: string | null;
  /** Approved figures only: a pending change is in `pendingRate`. */
  monthlyGross: Paise;
  dailyRate: Paise;
  monthlyTds: Paise;
  ptHalfYear: Paise;
  recoveryInstalment: Paise;
  isActive: boolean;
  pendingRate: { id: string; value: Paise } | null;
  /** Approved advances not yet recovered (a pending run's recovery counts as recovered). */
  advanceOutstanding: Paise;
}

export interface StaffAdvance {
  id: string;
  employeeId: string;
  employeeName: string;
  advDate: IsoDate;
  amount: Paise;
  mode: PaymentMode;
  reference: string | null;
  status: EntryStatus;
  rejectReason: string | null;
  submittedBy: string | null;
  submittedAt: string;
}

export interface PayrollLine extends Payslip {
  employeeId: string;
  name: string;
  roleTitle: string;
}

export interface PayrollRun {
  id: string;
  period: string;
  payDate: IsoDate;
  mode: PaymentMode;
  reference: string | null;
  totals: Payslip;
  status: EntryStatus;
  rejectReason: string | null;
  submittedBy: string | null;
  submittedAt: string;
  lines: PayrollLine[];
}

export interface RateChange {
  id: string;
  field: RateField;
  targetId: string;
  targetName: string;
  projectCode: string | null;
  oldValue: Paise;
  newValue: Paise;
  submittedBy: string | null;
  submittedAt: string;
}

interface EmployeeRow {
  id: string;
  kind: 'salaried' | 'daily';
  name: string;
  role_title: string;
  project_id: string | null;
  project_code: string | null;
  monthly_gross: string;
  daily_rate: string;
  monthly_tds: string;
  pt_half_year: string;
  recovery_instalment: string;
  is_active: boolean;
  pending_id: string | null;
  pending_value: string | null;
  outstanding: string;
}

/** Approved, live advances less recoveries on live (pending or approved) runs. */
const OUTSTANDING = `
  coalesce((SELECT sum(a.amount) FROM staff_advance a
             WHERE a.employee_id = e.id AND a.status = 'approved' AND a.deleted_at IS NULL), 0)
  - coalesce((SELECT sum(s.recovery) FROM payslip s JOIN payroll_run r ON r.id = s.run_id
             WHERE s.employee_id = e.id AND r.status <> 'rejected' AND r.deleted_at IS NULL), 0)`;

const EMPLOYEE_SELECT = `
  SELECT e.id, e.kind, e.name, e.role_title, e.project_id, pr.code AS project_code,
         e.monthly_gross::text, e.daily_rate::text, e.monthly_tds::text, e.pt_half_year::text,
         e.recovery_instalment::text, e.is_active, rc.id AS pending_id, rc.new_value::text AS pending_value,
         (${OUTSTANDING})::text AS outstanding
    FROM employee e
    LEFT JOIN project pr ON pr.id = e.project_id
    LEFT JOIN rate_change rc ON rc.employee_id = e.id AND rc.status = 'pending'`;

const toEmployee = (r: EmployeeRow): Employee => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  roleTitle: r.role_title,
  projectId: r.project_id,
  projectCode: r.project_code,
  monthlyGross: p(r.monthly_gross),
  dailyRate: p(r.daily_rate),
  monthlyTds: p(r.monthly_tds),
  ptHalfYear: p(r.pt_half_year),
  recoveryInstalment: p(r.recovery_instalment),
  isActive: r.is_active,
  pendingRate: r.pending_id ? { id: r.pending_id, value: p(r.pending_value ?? '0') } : null,
  advanceOutstanding: p(r.outstanding),
});

/** Staff are company-wide; a worker is visible with the payroll right on their project. */
function canSee(actor: Actor, e: { kind: string; project_id: string | null }): boolean {
  if (e.kind === 'salaried') return can(actor, 'payroll', 'view') && projectScope(actor) === null;
  return can(actor, 'payroll', 'view', e.project_id ?? undefined);
}

export async function loadEmployee(
  c: pg.PoolClient,
  actor: Actor,
  id: string,
  forUpdate = false,
): Promise<Employee> {
  assertId(id, 'Employee');
  const { rows } = await c.query<EmployeeRow>(
    `${EMPLOYEE_SELECT} WHERE e.id = $1${forUpdate ? ' FOR UPDATE OF e' : ''}`,
    [id],
  );
  const r = rows[0];
  if (!r || !canSee(actor, r)) throw new DomainError('NOT_FOUND', 'Employee not found.');
  return toEmployee(r);
}

/** Staff and workers, rate changes (H2), staff advances and monthly payroll runs (FR-17.1). */
export class PayrollService {
  constructor(private readonly pool: pg.Pool) {}

  async employees(actor: Actor, kind: 'salaried' | 'daily'): Promise<Employee[]> {
    authorize(actor, 'payroll', 'view');
    if (kind === 'salaried') assertAllProjects(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<EmployeeRow>(
        `${EMPLOYEE_SELECT} WHERE e.kind = $1 AND ($2::uuid[] IS NULL OR e.project_id = ANY($2::uuid[]))
         ORDER BY e.is_active DESC, e.name`,
        [kind, projectScope(actor)],
      );
      return rows.filter((r) => canSee(actor, r)).map(toEmployee);
    });
  }

  /**
   * Adds a member of staff or a worker. H2: a non-owner's salary or daily rate is a pending rate
   * change; until the Owner approves it the employee is on ₹0 and cannot be paid.
   */
  async createEmployee(actor: Actor, input: EmployeeInput): Promise<{ id: string }> {
    const data = parse(employeeSchema, input);
    authorize(actor, 'payroll', 'edit', data.projectId ?? undefined);
    if (data.kind === 'salaried') assertAllProjects(actor);
    const salaried = data.kind === 'salaried';
    const direct = !requiresApproval(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO employee (id, company_id, kind, name, role_title, project_id, monthly_gross, daily_rate,
                               monthly_tds, pt_half_year, recovery_instalment, created_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, app_user_id())`,
        [id, ...employeeParams(data, direct)],
      );
      if (!direct && data.rate > 0)
        await insertRateChange(c, salaried ? 'monthly_gross' : 'daily_rate', id, 0, data.rate);
      await writeAudit(c, { action: 'create', entity: 'employee', entityId: id, after: data });
      return { id };
    });
  }

  /** Everything except the rate, which goes through `requestRate` (H2). */
  async updateEmployee(actor: Actor, id: string, input: EmployeeUpdate): Promise<void> {
    const data = parse(employeeUpdate, input);
    authorize(actor, 'payroll', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      const e = await loadEmployee(c, actor, id, true);
      authorize(actor, 'payroll', 'edit', e.projectId ?? undefined);
      if (data.projectId !== undefined && data.projectId !== e.projectId)
        await assertCanMove(c, actor, e, data.projectId);
      await c.query(
        `UPDATE employee SET name = coalesce($2, name), role_title = coalesce($3, role_title),
                project_id = coalesce($4, project_id), monthly_tds = coalesce($5, monthly_tds),
                pt_half_year = coalesce($6, pt_half_year),
                recovery_instalment = coalesce($7, recovery_instalment), is_active = coalesce($8, is_active),
                version = version + 1, updated_by = app_user_id()
          WHERE id = $1`,
        [id, ...updateParams(data, e.kind === 'salaried')],
      );
      await writeAudit(c, { action: 'update', entity: 'employee', entityId: id, after: data });
    });
  }

  /** H2: the Owner changes a salary or daily rate at once; anyone else asks for approval. */
  async requestRate(
    actor: Actor,
    employeeId: string,
    input: z.input<typeof rateSchema>,
  ): Promise<{ status: 'approved' | 'pending' }> {
    const { value } = parse(rateSchema, input);
    authorize(actor, 'payroll', 'edit');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const e = await loadEmployee(c, actor, employeeId, true);
      authorize(actor, 'payroll', 'edit', e.projectId ?? undefined);
      const field: RateField = e.kind === 'salaried' ? 'monthly_gross' : 'daily_rate';
      const current = field === 'monthly_gross' ? e.monthlyGross : e.dailyRate;
      if (value === current)
        throw new DomainError('VALIDATION', 'That is the current rate.', 'value');
      if (requiresApproval(actor)) {
        await insertRateChange(c, field, employeeId, current, value);
        return { status: 'pending' };
      }
      await supersedePending(c, 'employee_id', employeeId);
      await applyRate(c, field, employeeId, current, value);
      return { status: 'approved' };
    });
  }

  /** The Owner's queue (Approvals → Rate changes), within their project scope. */
  async pendingRates(actor: Actor): Promise<RateChange[]> {
    assertApprover(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<RateRow>(
        `${RATE_SELECT} WHERE rc.status = 'pending' ORDER BY rc.created_at`,
      );
      return rows.filter((r) => canSeeRate(actor, r)).map(toRateChange);
    });
  }

  async approveRate(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Rate change');
    assertApprover(actor);
    await withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      const rc = await lockRate(c, actor, id);
      if (rc.field === 'job_value') {
        const committed = await jobCommitted(c, rc.targetId);
        if (rc.newValue < committed)
          throw new DomainError(
            'CONFLICT',
            'The new job value is less than what is already paid or pending.',
          );
      }
      await applyRate(c, rc.field, rc.targetId, rc.oldValue, rc.newValue);
      await c.query(
        `UPDATE rate_change SET status = 'approved', decided_by = app_user_id(), decided_at = now() WHERE id = $1`,
        [id],
      );
    });
  }

  async rejectRate(actor: Actor, id: string, input: z.input<typeof rejectSchema>): Promise<void> {
    assertId(id, 'Rate change');
    const { reason } = parse(rejectSchema, input);
    assertApprover(actor);
    await withTenant(this.pool, ctx(actor), async (c) => {
      await lockRate(c, actor, id);
      await c.query(
        `UPDATE rate_change SET status = 'rejected', reject_reason = $2, decided_by = app_user_id(),
                decided_at = now() WHERE id = $1`,
        [id, reason],
      );
      await writeAudit(c, {
        action: 'reject',
        entity: 'rate_change',
        entityId: id,
        after: { reason },
      });
    });
  }

  /** The author (or `payroll = full`) withdraws a pending rate change. */
  async withdrawRate(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Rate change');
    authorize(actor, 'payroll', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const rc = await lockRate(c, actor, id);
      if (rc.createdBy !== actor.userId)
        authorize(actor, 'payroll', 'full', rc.projectId ?? undefined);
      await c.query(
        `UPDATE rate_change SET status = 'withdrawn', decided_by = app_user_id(), decided_at = now() WHERE id = $1`,
        [id],
      );
      await writeAudit(c, { action: 'withdraw', entity: 'rate_change', entityId: id });
    });
  }

  // ---- Staff advances -----------------------------------------------------------------------

  async advances(
    actor: Actor,
    filter: { status?: EntryStatus | undefined } = {},
  ): Promise<StaffAdvance[]> {
    authorize(actor, 'payroll', 'view');
    assertAllProjects(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<AdvanceRow>(
        `${ADVANCE_SELECT} AND ($1::text IS NULL OR a.status = $1) ORDER BY a.adv_date DESC, a.created_at DESC
         LIMIT 500`,
        [filter.status ?? null],
      );
      return rows.map(toAdvance);
    });
  }

  /** Dr Staff advances / Cr cash, bank or UPI; recovered through later payslips. */
  async recordAdvance(
    actor: Actor,
    input: AdvanceInput,
  ): Promise<{ id: string; status: EntryStatus }> {
    const data = parse(advanceSchema, input);
    authorize(actor, 'payroll', 'edit');
    assertAllProjects(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const e = await loadEmployee(c, actor, data.employeeId);
      if (e.kind !== 'salaried' || !e.isActive)
        throw new DomainError(
          'VALIDATION',
          'Advances are for active salaried staff.',
          'employeeId',
        );
      assertNotLocked(data.advDate, (await companyRow(c)).lock_date, 'advDate');
      const id = randomUUID();
      const { approved, status } = decision(actor);
      const journalId = approved ? await postAdvance(c, id, data, e.name) : null;
      await c.query(
        `INSERT INTO staff_advance (id, company_id, employee_id, adv_date, amount, mode, reference, account_code,
                                    status, decided_by, decided_at, journal_id, created_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8,
                 CASE WHEN $9 THEN app_user_id() END, CASE WHEN $9 THEN now() END, $10, app_user_id())`,
        [
          id,
          data.employeeId,
          data.advDate,
          d(data.amount),
          data.mode,
          data.reference || null,
          accountFor(data.mode),
          status,
          approved,
          journalId,
        ],
      );
      await writeAudit(c, {
        action: 'create',
        entity: 'staff_advance',
        entityId: id,
        after: { ...data, status },
      });
      return { id, status };
    });
  }

  async approveAdvance(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Advance');
    assertApprover(actor);
    await withTenant(this.pool, ctx(actor), async (c) => {
      const e = await lockEntry(c, actor, ENTRY.staff_advance, id);
      assertPending(e, ENTRY.staff_advance);
      assertNotLocked(e.date, (await companyRow(c)).lock_date, 'advDate');
      const a = await advanceById(c, id);
      const journalId = await postAdvance(c, id, a, a.employeeName);
      await markApproved(c, ENTRY.staff_advance, id, journalId);
    });
  }

  async rejectAdvance(
    actor: Actor,
    id: string,
    input: z.input<typeof rejectSchema>,
  ): Promise<void> {
    assertId(id, 'Advance');
    const { reason } = parse(rejectSchema, input);
    assertApprover(actor);
    await withTenant(this.pool, ctx(actor), async (c) => {
      assertPending(await lockEntry(c, actor, ENTRY.staff_advance, id), ENTRY.staff_advance);
      await markRejected(c, ENTRY.staff_advance, id, reason);
    });
  }

  /** A posted advance that payroll has already (partly) recovered cannot be removed. */
  async removeAdvance(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Advance');
    authorize(actor, 'payroll', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      const e = await lockEntry(c, actor, ENTRY.staff_advance, id);
      const a = await advanceById(c, id);
      if (e.status === 'approved') {
        const emp = await loadEmployee(c, actor, a.employeeId);
        if (emp.advanceOutstanding < a.amount)
          throw new DomainError('CONFLICT', 'Payroll has already recovered part of this advance.');
      }
      await removeEntry(
        c,
        actor,
        ENTRY.staff_advance,
        e,
        `Staff advance to ${a.employeeName} deleted`,
      );
    });
  }

  // ---- Payroll runs -------------------------------------------------------------------------

  /** What processing `period` would pay: active staff on a salary, with their deductions. */
  async preview(actor: Actor, period: string): Promise<PayrollLine[]> {
    assertPeriod(period);
    authorize(actor, 'payroll', 'view');
    assertAllProjects(actor);
    return withTenant(this.pool, ctx(actor), (c) => linesFor(c, period));
  }

  async runs(actor: Actor): Promise<PayrollRun[]> {
    authorize(actor, 'payroll', 'view');
    assertAllProjects(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<RunRow>(
        `${RUN_SELECT} ORDER BY r.period DESC, r.created_at DESC LIMIT 60`,
      );
      return Promise.all(rows.map(async (r) => toRun(r, await payslips(c, r.id))));
    });
  }

  async run(actor: Actor, id: string): Promise<PayrollRun> {
    assertId(id, 'Payroll run');
    authorize(actor, 'payroll', 'view');
    assertAllProjects(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<RunRow>(`${RUN_SELECT} AND r.id = $1`, [id]);
      const r = rows[0];
      if (!r) throw new DomainError('NOT_FOUND', 'Payroll run not found.');
      return toRun(r, await payslips(c, id));
    });
  }

  /**
   * "Process payroll" (FR-17.1): one live run a month, with a payslip per member of staff.
   * Pending for a non-owner (H2); its advance recoveries are held until it is decided.
   */
  async process(actor: Actor, input: RunInput): Promise<{ id: string; status: EntryStatus }> {
    const data = parse(runSchema, input);
    authorize(actor, 'payroll', 'edit');
    assertAllProjects(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      assertNotLocked(data.payDate, (await companyRow(c)).lock_date, 'payDate');
      const live = await c.query(
        `SELECT 1 FROM payroll_run WHERE period = $1 AND status <> 'rejected' AND deleted_at IS NULL`,
        [data.period],
      );
      if (live.rowCount)
        throw new DomainError('CONFLICT', `Payroll for ${data.period} is already processed.`);
      const lines = await linesFor(c, data.period);
      if (lines.length === 0)
        throw new DomainError(
          'VALIDATION',
          'No active staff have a monthly salary to pay.',
          'period',
        );
      const totals = sumSlips(lines);
      const id = randomUUID();
      const { approved, status } = decision(actor);
      await insertRun(c, id, data, totals);
      for (const l of lines) await insertPayslip(c, id, l);
      if (approved) {
        const journalId = await postRun(c, id, data, totals);
        await c.query(
          `UPDATE payroll_run SET status = 'approved', journal_id = $2, decided_by = app_user_id(),
                  decided_at = now() WHERE id = $1`,
          [id, journalId],
        );
      }
      await writeAudit(c, {
        action: 'create',
        entity: 'payroll_run',
        entityId: id,
        after: { ...data, totals, status },
      });
      return { id, status };
    });
  }

  async approveRun(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Payroll run');
    assertApprover(actor);
    await withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      const e = await lockEntry(c, actor, ENTRY.payroll_run, id);
      assertPending(e, ENTRY.payroll_run);
      assertNotLocked(e.date, (await companyRow(c)).lock_date, 'payDate');
      const { rows } = await c.query<RunRow>(`${RUN_SELECT} AND r.id = $1`, [id]);
      const row = rows[0];
      if (!row) throw new DomainError('NOT_FOUND', 'Payroll run not found.');
      const run = toRun(row, []);
      const journalId = await postRun(
        c,
        id,
        { period: run.period, payDate: run.payDate, mode: run.mode },
        run.totals,
      );
      await markApproved(c, ENTRY.payroll_run, id, journalId);
    });
  }

  async rejectRun(actor: Actor, id: string, input: z.input<typeof rejectSchema>): Promise<void> {
    assertId(id, 'Payroll run');
    const { reason } = parse(rejectSchema, input);
    assertApprover(actor);
    await withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      assertPending(await lockEntry(c, actor, ENTRY.payroll_run, id), ENTRY.payroll_run);
      await markRejected(c, ENTRY.payroll_run, id, reason);
    });
  }

  async removeRun(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Payroll run');
    authorize(actor, 'payroll', 'edit');
    assertAllProjects(actor);
    await withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      const e = await lockEntry(c, actor, ENTRY.payroll_run, id);
      await removeEntry(c, actor, ENTRY.payroll_run, e, `Payroll run deleted`);
    });
  }
}

// ---- Rate changes ---------------------------------------------------------------------------

interface RateRow {
  id: string;
  field: RateField;
  target_id: string;
  target_name: string;
  kind: string;
  project_id: string | null;
  project_code: string | null;
  old_value: string;
  new_value: string;
  submitted_by: string | null;
  created_by: string | null;
  created_at: Date;
}

const RATE_SELECT = `
  SELECT rc.id, rc.field, coalesce(rc.employee_id, rc.contract_job_id) AS target_id,
         coalesce(e.name, j.contractor || ' · ' || j.work) AS target_name,
         CASE WHEN rc.field = 'monthly_gross' THEN 'salaried' ELSE 'scoped' END AS kind,
         coalesce(e.project_id, j.project_id) AS project_id, pr.code AS project_code,
         rc.old_value::text, rc.new_value::text, u.name AS submitted_by, rc.created_by, rc.created_at
    FROM rate_change rc
    LEFT JOIN employee e ON e.id = rc.employee_id
    LEFT JOIN contract_job j ON j.id = rc.contract_job_id
    LEFT JOIN project pr ON pr.id = coalesce(e.project_id, j.project_id)
    LEFT JOIN app_user u ON u.id = rc.created_by`;

const canSeeRate = (actor: Actor, r: RateRow) =>
  r.kind === 'salaried'
    ? can(actor, 'payroll', 'view') && projectScope(actor) === null
    : can(actor, 'payroll', 'view', r.project_id ?? undefined);

const toRateChange = (r: RateRow): RateChange => ({
  id: r.id,
  field: r.field,
  targetId: r.target_id,
  targetName: r.target_name,
  projectCode: r.project_code,
  oldValue: p(r.old_value),
  newValue: p(r.new_value),
  submittedBy: r.submitted_by,
  submittedAt: r.created_at.toISOString(),
});

async function lockRate(c: pg.PoolClient, actor: Actor, id: string) {
  const { rows } = await c.query<RateRow & { status: string }>(
    `${RATE_SELECT.replace('SELECT rc.id,', 'SELECT rc.status, rc.id,')} WHERE rc.id = $1 FOR UPDATE OF rc`,
    [id],
  );
  const r = rows[0];
  if (!r || !canSeeRate(actor, r)) throw new DomainError('NOT_FOUND', 'Rate change not found.');
  if (r.status !== 'pending')
    throw new DomainError('CONFLICT', `This rate change is already ${r.status}.`);
  return { ...toRateChange(r), createdBy: r.created_by, projectId: r.project_id };
}

export async function insertRateChange(
  c: pg.PoolClient,
  field: RateField,
  targetId: string,
  oldValue: Paise,
  newValue: Paise,
): Promise<void> {
  const job = field === 'job_value';
  try {
    await c.query('SAVEPOINT rate_change');
    await c.query(
      `INSERT INTO rate_change (company_id, field, employee_id, contract_job_id, old_value, new_value, status, created_by)
       VALUES (app_company_id(), $1, $2, $3, $4, $5, 'pending', app_user_id())`,
      [field, job ? null : targetId, job ? targetId : null, d(oldValue), d(newValue)],
    );
    await c.query('RELEASE SAVEPOINT rate_change');
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT rate_change');
    if ((e as { code?: string }).code === '23505')
      throw new DomainError('CONFLICT', 'A change to this rate is already waiting for the owner.');
    throw e;
  }
  await writeAudit(c, {
    action: 'request',
    entity: 'rate_change',
    entityId: targetId,
    after: { field, oldValue, newValue },
  });
}

/** The Owner's direct change replaces any change waiting on the same figure. */
export async function supersedePending(
  c: pg.PoolClient,
  column: 'employee_id' | 'contract_job_id',
  targetId: string,
): Promise<void> {
  await c.query(
    `UPDATE rate_change SET status = 'rejected', reject_reason = 'Replaced by the owner''s change.',
            decided_by = app_user_id(), decided_at = now()
      WHERE ${column} = $1 AND status = 'pending'`,
    [targetId],
  );
}

export async function applyRate(
  c: pg.PoolClient,
  field: RateField,
  targetId: string,
  oldValue: Paise,
  newValue: Paise,
): Promise<void> {
  const sql =
    field === 'job_value'
      ? `UPDATE contract_job SET value = $2, version = version + 1, updated_by = app_user_id() WHERE id = $1`
      : `UPDATE employee SET ${field} = $2, version = version + 1, updated_by = app_user_id() WHERE id = $1`;
  await c.query(sql, [targetId, d(newValue)]);
  await writeAudit(c, {
    action: 'rate_change',
    entity: field === 'job_value' ? 'contract_job' : 'employee',
    entityId: targetId,
    before: { [field]: oldValue },
    after: { [field]: newValue },
  });
}

/** Paid plus pending on a contract job. */
export async function jobCommitted(c: pg.PoolClient, jobId: string): Promise<Paise> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT coalesce(sum(amount), 0)::text AS n FROM contract_payment
      WHERE job_id = $1 AND status <> 'rejected' AND deleted_at IS NULL`,
    [jobId],
  );
  return p(rows[0]?.n ?? '0');
}

/** Insert parameters $2…$10 for a new employee; a non-owner's rate starts at 0 (H2). */
function employeeParams(data: z.output<typeof employeeSchema>, direct: boolean): unknown[] {
  const salaried = data.kind === 'salaried';
  const rate = direct ? data.rate : 0;
  return [
    data.kind,
    data.name,
    data.roleTitle,
    data.projectId ?? null,
    d(salaried ? rate : 0),
    d(salaried ? 0 : rate),
    d(salaried ? data.monthlyTds : 0),
    d(salaried ? data.ptHalfYear : 0),
    d(data.recoveryInstalment),
  ];
}

/** Update parameters $2…$8; NULL keeps the old value. TDS and PT apply to staff only. */
function updateParams(data: z.output<typeof employeeUpdate>, salaried: boolean): unknown[] {
  const money = (v: Paise | undefined) => (v === undefined ? null : d(v));
  return [
    data.name ?? null,
    data.roleTitle ?? null,
    data.projectId ?? null,
    salaried ? money(data.monthlyTds) : null,
    salaried ? money(data.ptHalfYear) : null,
    money(data.recoveryInstalment),
    data.isActive ?? null,
  ];
}

/** Only a worker moves project, into one the actor may edit, once their wages are settled. */
async function assertCanMove(
  c: pg.PoolClient,
  actor: Actor,
  e: Employee,
  projectId: string,
): Promise<void> {
  if (e.kind === 'salaried')
    throw new DomainError('VALIDATION', 'Staff are not tied to a project.', 'projectId');
  authorize(actor, 'payroll', 'edit', projectId);
  await assertNoWageBalance(c, e);
}

/** A worker moves project only once their wages there are settled. */
async function assertNoWageBalance(c: pg.PoolClient, e: Employee): Promise<void> {
  const { rows } = await c.query<{ earned: string; paid: string }>(
    `SELECT coalesce((SELECT sum(round(rate * tenths / 10.0, 2)) FROM attendance
                       WHERE employee_id = $1 AND project_id = $2), 0)::text AS earned,
            coalesce((SELECT sum(amount) FROM wage_payment
                       WHERE employee_id = $1 AND project_id = $2 AND status <> 'rejected'
                         AND deleted_at IS NULL), 0)::text AS paid`,
    [e.id, e.projectId],
  );
  const r = rows[0];
  if (r && p(r.earned) !== p(r.paid))
    throw new DomainError(
      'CONFLICT',
      'Settle the wages on the current project before moving the worker.',
      'projectId',
    );
}

// ---- Advances -------------------------------------------------------------------------------

interface AdvanceRow {
  id: string;
  employee_id: string;
  employee_name: string;
  adv_date: string;
  amount: string;
  mode: PaymentMode;
  reference: string | null;
  status: EntryStatus;
  reject_reason: string | null;
  submitted_by: string | null;
  created_at: Date;
}

const ADVANCE_SELECT = `
  SELECT a.id, a.employee_id, e.name AS employee_name, to_char(a.adv_date, 'YYYY-MM-DD') AS adv_date,
         a.amount::text, a.mode, a.reference, a.status, a.reject_reason, u.name AS submitted_by, a.created_at
    FROM staff_advance a JOIN employee e ON e.id = a.employee_id
    LEFT JOIN app_user u ON u.id = a.created_by
   WHERE a.deleted_at IS NULL`;

const toAdvance = (r: AdvanceRow): StaffAdvance => ({
  id: r.id,
  employeeId: r.employee_id,
  employeeName: r.employee_name,
  advDate: r.adv_date,
  amount: p(r.amount),
  mode: r.mode,
  reference: r.reference,
  status: r.status,
  rejectReason: r.reject_reason,
  submittedBy: r.submitted_by,
  submittedAt: r.created_at.toISOString(),
});

export async function pendingAdvances(c: pg.PoolClient): Promise<StaffAdvance[]> {
  const { rows } = await c.query<AdvanceRow>(
    `${ADVANCE_SELECT} AND a.status = 'pending' ORDER BY a.created_at`,
  );
  return rows.map(toAdvance);
}

async function advanceById(c: pg.PoolClient, id: string): Promise<StaffAdvance> {
  const { rows } = await c.query<AdvanceRow>(`${ADVANCE_SELECT} AND a.id = $1`, [id]);
  const r = rows[0];
  if (!r) throw new DomainError('NOT_FOUND', 'Advance not found.');
  return toAdvance(r);
}

async function postAdvance(
  c: pg.PoolClient,
  id: string,
  a: { advDate: IsoDate; amount: Paise; mode: PaymentMode },
  name: string,
): Promise<string> {
  return postJournal(c, {
    txnDate: a.advDate,
    sourceType: 'staff_advance',
    sourceId: id,
    narration: `Salary advance to ${name}`,
    lines: [
      { accountCode: '1300', debit: a.amount },
      { accountCode: accountFor(a.mode), credit: a.amount },
    ],
  });
}

// ---- Runs -----------------------------------------------------------------------------------

interface RunRow {
  id: string;
  period: string;
  pay_date: string;
  mode: PaymentMode;
  reference: string | null;
  gross: string;
  tds: string;
  pt: string;
  recovery: string;
  net: string;
  status: EntryStatus;
  reject_reason: string | null;
  submitted_by: string | null;
  created_at: Date;
}

const RUN_SELECT = `
  SELECT r.id, r.period, to_char(r.pay_date, 'YYYY-MM-DD') AS pay_date, r.mode, r.reference, r.gross::text,
         r.tds::text, r.pt::text, r.recovery::text, r.net::text, r.status, r.reject_reason,
         u.name AS submitted_by, r.created_at
    FROM payroll_run r LEFT JOIN app_user u ON u.id = r.created_by
   WHERE r.deleted_at IS NULL`;

const toRun = (r: RunRow, lines: PayrollLine[]): PayrollRun => ({
  id: r.id,
  period: r.period,
  payDate: r.pay_date,
  mode: r.mode,
  reference: r.reference,
  totals: { gross: p(r.gross), tds: p(r.tds), pt: p(r.pt), recovery: p(r.recovery), net: p(r.net) },
  status: r.status,
  rejectReason: r.reject_reason,
  submittedBy: r.submitted_by,
  submittedAt: r.created_at.toISOString(),
  lines,
});

export async function pendingRuns(c: pg.PoolClient): Promise<PayrollRun[]> {
  const { rows } = await c.query<RunRow>(
    `${RUN_SELECT} AND r.status = 'pending' ORDER BY r.created_at`,
  );
  return Promise.all(rows.map(async (r) => toRun(r, await payslips(c, r.id))));
}

async function payslips(c: pg.PoolClient, runId: string): Promise<PayrollLine[]> {
  const { rows } = await c.query<{
    employee_id: string;
    name: string;
    role_title: string;
    gross: string;
    tds: string;
    pt: string;
    recovery: string;
    net: string;
  }>(
    `SELECT employee_id, name, role_title, gross::text, tds::text, pt::text, recovery::text, net::text
       FROM payslip WHERE run_id = $1 ORDER BY name`,
    [runId],
  );
  return rows.map((r) => ({
    employeeId: r.employee_id,
    name: r.name,
    roleTitle: r.role_title,
    gross: p(r.gross),
    tds: p(r.tds),
    pt: p(r.pt),
    recovery: p(r.recovery),
    net: p(r.net),
  }));
}

async function linesFor(c: pg.PoolClient, period: string): Promise<PayrollLine[]> {
  monthRange(period);
  const { rows } = await c.query<EmployeeRow>(
    `${EMPLOYEE_SELECT} WHERE e.kind = 'salaried' AND e.is_active AND e.monthly_gross > 0 ORDER BY e.name`,
  );
  return rows.map(toEmployee).map((e) => ({
    employeeId: e.id,
    name: e.name,
    roleTitle: e.roleTitle,
    ...payslipFor(period, {
      gross: e.monthlyGross,
      monthlyTds: e.monthlyTds,
      ptHalfYear: e.ptHalfYear,
      recoveryInstalment: e.recoveryInstalment,
      advanceOutstanding: Math.max(0, e.advanceOutstanding),
    }),
  }));
}

const sumSlips = (lines: readonly Payslip[]): Payslip =>
  lines.reduce(
    (s, l) => ({
      gross: s.gross + l.gross,
      tds: s.tds + l.tds,
      pt: s.pt + l.pt,
      recovery: s.recovery + l.recovery,
      net: s.net + l.net,
    }),
    { gross: 0, tds: 0, pt: 0, recovery: 0, net: 0 },
  );

/** Inserted pending; an Owner's run is approved in place once its payslips and journal exist. */
async function insertRun(
  c: pg.PoolClient,
  id: string,
  data: z.output<typeof runSchema>,
  t: Payslip,
): Promise<void> {
  await c.query(
    `INSERT INTO payroll_run (id, company_id, period, pay_date, mode, reference, account_code, gross, tds, pt,
                              recovery, net, status, created_by)
     VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', app_user_id())`,
    [
      id,
      data.period,
      data.payDate,
      data.mode,
      data.reference || null,
      accountFor(data.mode),
      d(t.gross),
      d(t.tds),
      d(t.pt),
      d(t.recovery),
      d(t.net),
    ],
  );
}

async function insertPayslip(c: pg.PoolClient, runId: string, l: PayrollLine): Promise<void> {
  await c.query(
    `INSERT INTO payslip (company_id, run_id, employee_id, name, role_title, gross, tds, pt, recovery, net)
     VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      runId,
      l.employeeId,
      l.name,
      l.roleTitle,
      d(l.gross),
      d(l.tds),
      d(l.pt),
      d(l.recovery),
      d(l.net),
    ],
  );
}

/** Dr Salaries gross / Cr TDS payable / Cr PT payable / Cr Staff advances / Cr money for the net. */
async function postRun(
  c: pg.PoolClient,
  id: string,
  run: { period: string; payDate: IsoDate; mode: PaymentMode },
  t: Payslip,
): Promise<string> {
  const credits: [string, Paise][] = [
    ['2310', t.tds],
    ['2320', t.pt],
    ['1300', t.recovery],
    [accountFor(run.mode), t.net],
  ];
  const lines: JournalLineInput[] = [
    { accountCode: '6000', debit: t.gross },
    ...credits.filter(([, v]) => v > 0).map(([accountCode, credit]) => ({ accountCode, credit })),
  ];
  return postJournal(c, {
    txnDate: run.payDate,
    sourceType: 'payroll_run',
    sourceId: id,
    narration: `Salaries for ${run.period}`,
    lines,
  });
}
