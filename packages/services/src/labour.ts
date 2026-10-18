import { randomUUID } from 'node:crypto';
import {
  CONTRACT_TDS_RATES,
  DomainError,
  assertApprover,
  assertId,
  assertNotLocked,
  authorize,
  can,
  contractTds,
  formatInr,
  fromDecimalString,
  projectScope,
  requiresApproval,
  toDecimalString,
  todayIn,
  wagesFor,
  type Actor,
  type ContractTdsRate,
  type IsoDate,
  type Paise,
  type PaymentMode,
} from '@csd/core';
import { postJournal, withTenant, writeAudit, type JournalLineInput } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import {
  ENTRY,
  REFERENCE_MESSAGE,
  accountFor,
  amountSchema,
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
  type EntryTable,
} from './money-entries.js';
import { applyRate, insertRateChange, supersedePending } from './payroll.js';
import { companyRow, isoDate, parse, tenantOf as ctx } from './validation.js';

const p = fromDecimalString;
const d = toDecimalString;

const attendanceSchema = z.object({
  workDate: dateNotFuture('workDate').optional(),
  /** A full day (10) or half a day (5). */
  tenths: z.union([z.literal(10), z.literal(5)]).default(10),
});
const wageSchema = z
  .object({
    employeeId: z.string().uuid('Choose the worker.'),
    payDate: dateNotFuture('payDate'),
    amount: amountSchema,
    ...paidSchema,
  })
  .refine(needsReference, REFERENCE_MESSAGE);
const tdsRate = z
  .number()
  .refine((n): n is ContractTdsRate => (CONTRACT_TDS_RATES as readonly number[]).includes(n), {
    message: 'TDS u/s 194C is 1% (individual/HUF), 2% (others) or none.',
  });
const jobSchema = z.object({
  contractor: z.string().trim().min(1, 'Enter the contractor.').max(120),
  work: z.string().trim().min(1, 'Describe the work.').max(200),
  projectId: z.string().uuid('Choose a project.'),
  value: amountSchema,
  tdsRate: tdsRate.default(1),
});
const jobUpdate = z.object({
  work: z.string().trim().min(1, 'Describe the work.').max(200).optional(),
  progress: z.number().int().min(0).max(100, 'Progress is a percentage.').optional(),
  tdsRate: tdsRate.optional(),
  isClosed: z.boolean().optional(),
});
const contractPaySchema = z
  .object({
    jobId: z.string().uuid('Choose the contract job.'),
    payDate: dateNotFuture('payDate'),
    /** Settled against the job, before TDS. */
    amount: amountSchema,
    ...paidSchema,
  })
  .refine(needsReference, REFERENCE_MESSAGE);

export type WageInput = z.input<typeof wageSchema>;
export type JobInput = z.input<typeof jobSchema>;
export type JobUpdate = z.input<typeof jobUpdate>;
export type ContractPayInput = z.input<typeof contractPaySchema>;

export interface Worker {
  id: string;
  name: string;
  trade: string;
  projectId: string;
  projectCode: string;
  dailyRate: Paise;
  pendingRate: { id: string; value: Paise; createdBy: string | null } | null;
  isActive: boolean;
  /** Attendance on the current project, in tenths of a day. */
  tenths: number;
  markedToday: boolean;
  earned: Paise;
  paid: Paise;
  pending: Paise;
  /** Earned − paid − pending: what can still be paid. */
  balance: Paise;
}

export interface ContractJob {
  id: string;
  contractor: string;
  work: string;
  projectId: string;
  projectCode: string;
  value: Paise;
  pendingValue: { id: string; value: Paise; createdBy: string | null } | null;
  tdsRate: ContractTdsRate;
  progress: number;
  isClosed: boolean;
  paid: Paise;
  pending: Paise;
  balance: Paise;
}

export interface LabourPayment {
  id: string;
  kind: 'wage' | 'contract';
  /** Worker or contract job. */
  targetId: string;
  payee: string;
  detail: string;
  projectId: string;
  projectCode: string;
  payDate: IsoDate;
  amount: Paise;
  tds: Paise;
  mode: PaymentMode;
  reference: string | null;
  status: EntryStatus;
  rejectReason: string | null;
  submittedBy: string | null;
  /** The author's user id (who may withdraw it while pending). */
  createdBy: string | null;
  submittedAt: string;
}

const pendingOf = (r: {
  pending_id: string | null;
  pending_value: string | null;
  pending_by: string | null;
}) =>
  r.pending_id
    ? { id: r.pending_id, value: p(r.pending_value ?? '0'), createdBy: r.pending_by }
    : null;

interface WorkerRow {
  id: string;
  name: string;
  role_title: string;
  project_id: string;
  project_code: string;
  daily_rate: string;
  pending_id: string | null;
  pending_value: string | null;
  pending_by: string | null;
  is_active: boolean;
  tenths: string;
  marked_today: boolean;
  earned: string;
  paid: string;
  pending: string;
}

/** Earned, paid and pending on the worker's current project. */
const WORKER_SELECT = `
  SELECT e.id, e.name, e.role_title, e.project_id, pr.code AS project_code, e.daily_rate::text,
         rc.id AS pending_id, rc.new_value::text AS pending_value, rc.created_by AS pending_by, e.is_active,
         coalesce(att.tenths, 0)::text AS tenths, coalesce(att.today, false) AS marked_today,
         coalesce(att.earned, 0)::text AS earned, coalesce(w.paid, 0)::text AS paid,
         coalesce(w.pending, 0)::text AS pending
    FROM employee e
    JOIN project pr ON pr.id = e.project_id
    LEFT JOIN rate_change rc ON rc.employee_id = e.id AND rc.status = 'pending'
    LEFT JOIN LATERAL (
      SELECT sum(a.tenths) AS tenths, sum(round(a.rate * a.tenths / 10.0, 2)) AS earned,
             bool_or(a.work_date = $1::date) AS today
        FROM attendance a WHERE a.employee_id = e.id AND a.project_id = e.project_id) att ON true
    LEFT JOIN LATERAL (
      SELECT sum(x.amount) FILTER (WHERE x.status = 'approved') AS paid,
             sum(x.amount) FILTER (WHERE x.status = 'pending') AS pending
        FROM wage_payment x
       WHERE x.employee_id = e.id AND x.project_id = e.project_id AND x.deleted_at IS NULL) w ON true
   WHERE e.kind = 'daily'`;

const toWorker = (r: WorkerRow): Worker => {
  const earned = p(r.earned);
  const paid = p(r.paid);
  const pending = p(r.pending);
  return {
    id: r.id,
    name: r.name,
    trade: r.role_title,
    projectId: r.project_id,
    projectCode: r.project_code,
    dailyRate: p(r.daily_rate),
    pendingRate: pendingOf(r),
    isActive: r.is_active,
    tenths: Number(r.tenths),
    markedToday: r.marked_today,
    earned,
    paid,
    pending,
    balance: earned - paid - pending,
  };
};

interface JobRow {
  id: string;
  contractor: string;
  work: string;
  project_id: string;
  project_code: string;
  value: string;
  pending_id: string | null;
  pending_value: string | null;
  pending_by: string | null;
  tds_rate: number;
  progress: number;
  is_closed: boolean;
  paid: string;
  pending: string;
}

const JOB_SELECT = `
  SELECT j.id, j.contractor, j.work, j.project_id, pr.code AS project_code, j.value::text,
         rc.id AS pending_id, rc.new_value::text AS pending_value, rc.created_by AS pending_by, j.tds_rate, j.progress, j.is_closed,
         coalesce(sum(x.amount) FILTER (WHERE x.status = 'approved'), 0)::text AS paid,
         coalesce(sum(x.amount) FILTER (WHERE x.status = 'pending'), 0)::text AS pending
    FROM contract_job j
    JOIN project pr ON pr.id = j.project_id
    LEFT JOIN rate_change rc ON rc.contract_job_id = j.id AND rc.status = 'pending'
    LEFT JOIN contract_payment x ON x.job_id = j.id AND x.deleted_at IS NULL`;
const JOB_GROUP = ' GROUP BY j.id, pr.code, rc.id';

const toJob = (r: JobRow): ContractJob => {
  const value = p(r.value);
  const paid = p(r.paid);
  const pending = p(r.pending);
  return {
    id: r.id,
    contractor: r.contractor,
    work: r.work,
    projectId: r.project_id,
    projectCode: r.project_code,
    value,
    pendingValue: pendingOf(r),
    tdsRate: r.tds_rate as ContractTdsRate,
    progress: r.progress,
    isClosed: r.is_closed,
    paid,
    pending,
    balance: value - paid - pending,
  };
};

interface PaymentRow {
  id: string;
  target_id: string;
  payee: string;
  detail: string;
  project_id: string;
  project_code: string;
  pay_date: string;
  amount: string;
  tds: string;
  mode: PaymentMode;
  reference: string | null;
  status: EntryStatus;
  reject_reason: string | null;
  submitted_by: string | null;
  created_by: string | null;
  created_at: Date;
}

const PAYMENT_SELECT = {
  wage: `
    SELECT x.id, x.employee_id AS target_id, e.name AS payee, e.role_title AS detail, x.project_id,
           pr.code AS project_code, to_char(x.pay_date, 'YYYY-MM-DD') AS pay_date, x.amount::text,
           '0' AS tds, x.mode, x.reference, x.status, x.reject_reason, u.name AS submitted_by, x.created_by, x.created_at
      FROM wage_payment x JOIN employee e ON e.id = x.employee_id JOIN project pr ON pr.id = x.project_id
      LEFT JOIN app_user u ON u.id = x.created_by
     WHERE x.deleted_at IS NULL`,
  contract: `
    SELECT x.id, x.job_id AS target_id, j.contractor AS payee, j.work AS detail, x.project_id,
           pr.code AS project_code, to_char(x.pay_date, 'YYYY-MM-DD') AS pay_date, x.amount::text,
           x.tds::text, x.mode, x.reference, x.status, x.reject_reason, u.name AS submitted_by, x.created_by, x.created_at
      FROM contract_payment x JOIN contract_job j ON j.id = x.job_id JOIN project pr ON pr.id = x.project_id
      LEFT JOIN app_user u ON u.id = x.created_by
     WHERE x.deleted_at IS NULL`,
} as const;

const toPayment =
  (kind: 'wage' | 'contract') =>
  (r: PaymentRow): LabourPayment => ({
    id: r.id,
    kind,
    targetId: r.target_id,
    payee: r.payee,
    detail: r.detail,
    projectId: r.project_id,
    projectCode: r.project_code,
    payDate: r.pay_date,
    amount: p(r.amount),
    tds: p(r.tds),
    mode: r.mode,
    reference: r.reference,
    status: r.status,
    rejectReason: r.reject_reason,
    submittedBy: r.submitted_by,
    createdBy: r.created_by,
    submittedAt: r.created_at.toISOString(),
  });

const TABLE: Record<'wage' | 'contract', EntryTable> = {
  wage: ENTRY.wage_payment,
  contract: ENTRY.contract_payment,
};

/** Daily-wage labour (FR-17.2) and contractors paid per job (FR-17.3). */
export class LabourService {
  constructor(private readonly pool: pg.Pool) {}

  async workers(actor: Actor): Promise<Worker[]> {
    authorize(actor, 'payroll', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<WorkerRow>(
        `${WORKER_SELECT} AND ($2::uuid[] IS NULL OR e.project_id = ANY($2::uuid[]))
         ORDER BY e.is_active DESC, pr.code, e.name`,
        [todayIn(), projectScope(actor)],
      );
      return rows.filter((r) => can(actor, 'payroll', 'view', r.project_id)).map(toWorker);
    });
  }

  async worker(actor: Actor, id: string): Promise<Worker> {
    assertId(id, 'Worker');
    authorize(actor, 'payroll', 'view');
    return withTenant(this.pool, ctx(actor), (c) => workerById(c, actor, id));
  }

  /** "+1" (FR-17.2): marks a day (or half) at today's approved rate, on the worker's project. */
  async markAttendance(
    actor: Actor,
    employeeId: string,
    input: z.input<typeof attendanceSchema> = {},
  ): Promise<Worker> {
    const data = parse(attendanceSchema, input);
    const workDate = data.workDate ?? todayIn();
    authorize(actor, 'payroll', 'edit');
    return withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      const w = await workerById(c, actor, employeeId);
      authorize(actor, 'payroll', 'edit', w.projectId);
      if (!w.isActive) throw new DomainError('CONFLICT', 'This worker is inactive.');
      if (w.dailyRate === 0)
        throw new DomainError('CONFLICT', 'The daily rate is waiting for the owner’s approval.');
      assertNotLocked(workDate, (await companyRow(c)).lock_date, 'workDate');
      const r = await c.query(
        `INSERT INTO attendance (company_id, employee_id, project_id, work_date, tenths, rate, created_by)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, app_user_id()) ON CONFLICT (employee_id, work_date) DO NOTHING`,
        [employeeId, w.projectId, workDate, data.tenths, d(w.dailyRate)],
      );
      if (r.rowCount === 0)
        throw new DomainError('CONFLICT', `${w.name} is already marked for that day.`, 'workDate');
      await writeAudit(c, {
        action: 'attendance',
        entity: 'employee',
        entityId: employeeId,
        after: { workDate, tenths: data.tenths },
      });
      return workerById(c, actor, employeeId);
    });
  }

  /** Removes a day marked by mistake, unless its wages are already paid or pending. */
  async unmarkAttendance(actor: Actor, employeeId: string, workDate: IsoDate): Promise<Worker> {
    parse(isoDate, workDate);
    authorize(actor, 'payroll', 'edit');
    return withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      const w = await workerById(c, actor, employeeId);
      authorize(actor, 'payroll', 'edit', w.projectId);
      const { rows } = await c.query<{ rate: string; tenths: number }>(
        `SELECT rate::text, tenths FROM attendance WHERE employee_id = $1 AND work_date = $2 AND project_id = $3`,
        [employeeId, workDate, w.projectId],
      );
      const day = rows[0];
      if (!day) throw new DomainError('NOT_FOUND', 'No attendance on that day.');
      if (wagesFor(p(day.rate), day.tenths) > w.balance)
        throw new DomainError(
          'CONFLICT',
          'The wages for that day are already paid or waiting for approval.',
        );
      await c.query(`DELETE FROM attendance WHERE employee_id = $1 AND work_date = $2`, [
        employeeId,
        workDate,
      ]);
      await writeAudit(c, {
        action: 'attendance_remove',
        entity: 'employee',
        entityId: employeeId,
        before: { workDate },
      });
      return workerById(c, actor, employeeId);
    });
  }

  // ---- Contract jobs ------------------------------------------------------------------------

  async jobs(actor: Actor): Promise<ContractJob[]> {
    authorize(actor, 'payroll', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<JobRow>(
        `${JOB_SELECT} WHERE ($1::uuid[] IS NULL OR j.project_id = ANY($1::uuid[]))${JOB_GROUP}
         ORDER BY j.is_closed, pr.code, j.contractor`,
        [projectScope(actor)],
      );
      return rows.filter((r) => can(actor, 'payroll', 'view', r.project_id)).map(toJob);
    });
  }

  /** H2: a non-owner's job value waits for the Owner; until then the job cannot be paid. */
  async createJob(actor: Actor, input: JobInput): Promise<{ id: string }> {
    const data = parse(jobSchema, input);
    authorize(actor, 'payroll', 'edit', data.projectId);
    const direct = !requiresApproval(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO contract_job (id, company_id, contractor, work, project_id, value, tds_rate, created_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, app_user_id())`,
        [id, data.contractor, data.work, data.projectId, d(direct ? data.value : 0), data.tdsRate],
      );
      if (!direct) await insertRateChange(c, 'job_value', id, 0, data.value);
      await writeAudit(c, { action: 'create', entity: 'contract_job', entityId: id, after: data });
      return { id };
    });
  }

  async updateJob(actor: Actor, id: string, input: JobUpdate): Promise<void> {
    const data = parse(jobUpdate, input);
    authorize(actor, 'payroll', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const job = await jobById(c, actor, id, true);
      authorize(actor, 'payroll', 'edit', job.projectId);
      // BUG-144 (H2): the TDS rate changes the cash paid; only the Owner changes it.
      if (data.tdsRate !== undefined && data.tdsRate !== job.tdsRate && requiresApproval(actor))
        throw new DomainError('FORBIDDEN', 'Only the owner changes the TDS rate.');
      await c.query(
        `UPDATE contract_job SET work = coalesce($2, work), progress = coalesce($3, progress),
                tds_rate = coalesce($4, tds_rate), is_closed = coalesce($5, is_closed),
                version = version + 1, updated_by = app_user_id()
          WHERE id = $1`,
        [id, data.work ?? null, data.progress ?? null, data.tdsRate ?? null, data.isClosed ?? null],
      );
      await writeAudit(c, { action: 'update', entity: 'contract_job', entityId: id, after: data });
    });
  }

  /** H2: the Owner changes a job value at once; anyone else asks for approval. */
  async requestJobValue(
    actor: Actor,
    id: string,
    input: { value: Paise },
  ): Promise<{ status: 'approved' | 'pending' }> {
    const { value } = parse(z.object({ value: amountSchema }), input);
    authorize(actor, 'payroll', 'edit');
    return withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      const job = await jobById(c, actor, id, true);
      authorize(actor, 'payroll', 'edit', job.projectId);
      if (value === job.value)
        throw new DomainError('VALIDATION', 'That is the current value.', 'value');
      if (value < job.paid + job.pending)
        throw new DomainError(
          'VALIDATION',
          'The value is less than what is already paid or pending.',
          'value',
        );
      if (requiresApproval(actor)) {
        await insertRateChange(c, 'job_value', id, job.value, value);
        return { status: 'pending' };
      }
      await supersedePending(c, 'contract_job_id', id);
      await applyRate(c, 'job_value', id, job.value, value);
      return { status: 'approved' };
    });
  }

  // ---- Payments -----------------------------------------------------------------------------

  async payments(
    actor: Actor,
    kind: 'wage' | 'contract',
    filter: { targetId?: string | undefined; status?: EntryStatus | undefined } = {},
  ): Promise<LabourPayment[]> {
    authorize(actor, 'payroll', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const target = kind === 'wage' ? 'x.employee_id' : 'x.job_id';
      // The approval queue reads the oldest first, so a long queue never hides the oldest (BUG-192).
      const order =
        filter.status === 'pending' ? 'x.created_at ASC' : 'x.pay_date DESC, x.created_at DESC';
      const { rows } = await c.query<PaymentRow>(
        `${PAYMENT_SELECT[kind]} AND ($1::uuid[] IS NULL OR x.project_id = ANY($1::uuid[]))
           AND ($2::uuid IS NULL OR ${target} = $2) AND ($3::text IS NULL OR x.status = $3)
         ORDER BY ${order} LIMIT 500`,
        [projectScope(actor), filter.targetId ?? null, filter.status ?? null],
      );
      return rows.filter((r) => can(actor, 'payroll', 'view', r.project_id)).map(toPayment(kind));
    });
  }

  /** The Owner's queue (Approvals → Payroll). */
  async pendingPayments(actor: Actor): Promise<LabourPayment[]> {
    assertApprover(actor);
    const wages = await this.payments(actor, 'wage', { status: 'pending' });
    const contracts = await this.payments(actor, 'contract', { status: 'pending' });
    return [...wages, ...contracts].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  }

  /** "Pay wages" (FR-17.2): Dr Project cost – Labour / Cr cash, bank or UPI, up to the balance. */
  async payWages(actor: Actor, input: WageInput): Promise<{ id: string; status: EntryStatus }> {
    const data = parse(wageSchema, input);
    authorize(actor, 'payroll', 'edit');
    return withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      const w = await workerById(c, actor, data.employeeId);
      authorize(actor, 'payroll', 'edit', w.projectId);
      if (data.amount > w.balance)
        throw new DomainError(
          'VALIDATION',
          `The amount is more than the wages due (${formatInr(Math.max(0, w.balance))}).`,
          'amount',
        );
      assertNotLocked(data.payDate, (await companyRow(c)).lock_date, 'payDate');
      const id = randomUUID();
      const { approved, status } = decision(actor);
      const journalId = approved
        ? await postWage(c, id, { ...data, projectId: w.projectId }, w.name)
        : null;
      await c.query(
        `INSERT INTO wage_payment (id, company_id, employee_id, project_id, pay_date, amount, mode, reference,
                                   account_code, status, decided_by, decided_at, journal_id, created_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9,
                 CASE WHEN $10 THEN app_user_id() END, CASE WHEN $10 THEN now() END, $11, app_user_id())`,
        [
          id,
          data.employeeId,
          w.projectId,
          data.payDate,
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
        entity: 'wage_payment',
        entityId: id,
        after: { ...data, status },
      });
      return { id, status };
    });
  }

  /** "Pay" (FR-17.3): Dr Project cost – Subcontract gross / Cr money net / Cr TDS payable (194C). */
  async payContract(
    actor: Actor,
    input: ContractPayInput,
  ): Promise<{ id: string; status: EntryStatus }> {
    const data = parse(contractPaySchema, input);
    authorize(actor, 'payroll', 'edit');
    return withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      const job = await jobById(c, actor, data.jobId, true);
      authorize(actor, 'payroll', 'edit', job.projectId);
      if (job.isClosed) throw new DomainError('CONFLICT', 'This contract job is closed.');
      if (data.amount > job.balance)
        throw new DomainError(
          'VALIDATION',
          `The amount is more than the job balance (${formatInr(Math.max(0, job.balance))}).`,
          'amount',
        );
      assertNotLocked(data.payDate, (await companyRow(c)).lock_date, 'payDate');
      const tds = contractTds(data.amount, job.tdsRate);
      const id = randomUUID();
      const { approved, status } = decision(actor);
      const journalId = approved ? await postContract(c, id, { ...data, tds }, job) : null;
      await c.query(
        `INSERT INTO contract_payment (id, company_id, job_id, project_id, pay_date, amount, tds, mode, reference,
                                       account_code, status, decided_by, decided_at, journal_id, created_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 CASE WHEN $11 THEN app_user_id() END, CASE WHEN $11 THEN now() END, $12, app_user_id())`,
        [
          id,
          data.jobId,
          job.projectId,
          data.payDate,
          d(data.amount),
          d(tds),
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
        entity: 'contract_payment',
        entityId: id,
        after: { ...data, tds, status },
      });
      return { id, status };
    });
  }

  async approvePayment(actor: Actor, kind: 'wage' | 'contract', id: string): Promise<void> {
    assertId(id, 'Payment');
    assertApprover(actor);
    await withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      const e = await lockEntry(c, actor, TABLE[kind], id);
      assertPending(e, TABLE[kind]);
      assertNotLocked(e.date, (await companyRow(c)).lock_date, 'payDate');
      const pay = await paymentById(c, kind, id);
      const journalId =
        kind === 'wage'
          ? await postWage(c, id, pay, pay.payee)
          : await postContract(c, id, pay, await jobById(c, actor, pay.targetId));
      await markApproved(c, TABLE[kind], id, journalId);
    });
  }

  async rejectPayment(
    actor: Actor,
    kind: 'wage' | 'contract',
    id: string,
    input: z.input<typeof rejectSchema>,
  ): Promise<void> {
    assertId(id, 'Payment');
    const { reason } = parse(rejectSchema, input);
    assertApprover(actor);
    await withTenant(this.pool, ctx(actor), async (c) => {
      assertPending(await lockEntry(c, actor, TABLE[kind], id), TABLE[kind]);
      await markRejected(c, TABLE[kind], id, reason);
    });
  }

  async removePayment(actor: Actor, kind: 'wage' | 'contract', id: string): Promise<void> {
    assertId(id, 'Payment');
    authorize(actor, 'payroll', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      await payrollLock(c);
      const e = await lockEntry(c, actor, TABLE[kind], id);
      const pay = await paymentById(c, kind, id);
      // BUG-142: reversing wages on a project the worker has left would strand them there.
      if (kind === 'wage' && e.status === 'approved') {
        const w = await workerById(c, actor, pay.targetId).catch(() => null);
        if (w && w.projectId !== pay.projectId)
          throw new DomainError(
            'CONFLICT',
            `${pay.payee} has moved to ${w.projectCode}; move them back to reverse wages on ${pay.projectCode}.`,
          );
      }
      await removeEntry(
        c,
        actor,
        TABLE[kind],
        e,
        `${kind === 'wage' ? 'Wages' : 'Contract payment'} to ${pay.payee} deleted`,
      );
    });
  }
}

async function workerById(c: pg.PoolClient, actor: Actor, id: string): Promise<Worker> {
  assertId(id, 'Worker');
  const { rows } = await c.query<WorkerRow>(`${WORKER_SELECT} AND e.id = $2`, [todayIn(), id]);
  const r = rows[0];
  // A salaried employee's id reads as not found here, like an unknown one.
  if (!r || !can(actor, 'payroll', 'view', r.project_id))
    throw new DomainError('NOT_FOUND', 'Worker not found.');
  return toWorker(r);
}

async function jobById(
  c: pg.PoolClient,
  actor: Actor,
  id: string,
  forUpdate = false,
): Promise<ContractJob> {
  assertId(id, 'Contract job');
  if (forUpdate) await c.query(`SELECT 1 FROM contract_job WHERE id = $1 FOR UPDATE`, [id]);
  const { rows } = await c.query<JobRow>(`${JOB_SELECT} WHERE j.id = $1${JOB_GROUP}`, [id]);
  const r = rows[0];
  if (!r || !can(actor, 'payroll', 'view', r.project_id))
    throw new DomainError('NOT_FOUND', 'Contract job not found.');
  return toJob(r);
}

async function paymentById(
  c: pg.PoolClient,
  kind: 'wage' | 'contract',
  id: string,
): Promise<LabourPayment> {
  const { rows } = await c.query<PaymentRow>(`${PAYMENT_SELECT[kind]} AND x.id = $1`, [id]);
  const r = rows[0];
  if (!r) throw new DomainError('NOT_FOUND', 'Payment not found.');
  return toPayment(kind)(r);
}

async function postWage(
  c: pg.PoolClient,
  id: string,
  pay: { payDate: IsoDate; amount: Paise; mode: PaymentMode; projectId: string },
  name: string,
): Promise<string> {
  return postJournal(c, {
    txnDate: pay.payDate,
    sourceType: 'wage_payment',
    sourceId: id,
    narration: `Wages to ${name}`,
    lines: [
      { accountCode: '5010', debit: pay.amount, projectId: pay.projectId },
      { accountCode: accountFor(pay.mode), credit: pay.amount, projectId: pay.projectId },
    ],
  });
}

async function postContract(
  c: pg.PoolClient,
  id: string,
  pay: { payDate: IsoDate; amount: Paise; tds: Paise; mode: PaymentMode },
  job: ContractJob,
): Promise<string> {
  const lines: JournalLineInput[] = [
    { accountCode: '5020', debit: pay.amount, projectId: job.projectId },
    { accountCode: accountFor(pay.mode), credit: pay.amount - pay.tds, projectId: job.projectId },
  ];
  if (pay.tds > 0) lines.push({ accountCode: '2310', credit: pay.tds, projectId: job.projectId });
  return postJournal(c, {
    txnDate: pay.payDate,
    sourceType: 'contract_payment',
    sourceId: id,
    narration: `${job.contractor}: ${job.work}`,
    lines,
  });
}
