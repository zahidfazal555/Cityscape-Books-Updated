import {
  ACCOUNT_FOR_MODE,
  DomainError,
  PAYMENT_MODES,
  authorize,
  can,
  projectScope,
  requiresApproval,
  todayIn,
  type Actor,
  type IsoDate,
  type PaymentMode,
} from '@csd/core';
import { reverseJournal, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { isoDate } from './validation.js';

/**
 * Shared life cycle of the payroll module's money rows (staff advances, payroll runs, wage and
 * contractor payments). H2: a non-owner's entry is Pending and posts nothing; the Owner approves
 * (it posts, dated its own date) or rejects it; the author withdraws a pending one; only the
 * Owner reverses a posted one.
 */
export type EntryStatus = 'pending' | 'approved' | 'rejected';

export interface EntryTable {
  table: 'staff_advance' | 'payroll_run' | 'wage_payment' | 'contract_payment';
  dateCol: 'adv_date' | 'pay_date';
  /** For messages: "This advance is already approved." */
  noun: string;
  /** NULL for company-wide rows (advances follow their employee's project, runs have none). */
  projectSql: string;
}

export const ENTRY: Record<EntryTable['table'], EntryTable> = {
  staff_advance: {
    table: 'staff_advance',
    dateCol: 'adv_date',
    noun: 'advance',
    projectSql: 'NULL::uuid',
  },
  payroll_run: {
    table: 'payroll_run',
    dateCol: 'pay_date',
    noun: 'payroll run',
    projectSql: 'NULL::uuid',
  },
  wage_payment: {
    table: 'wage_payment',
    dateCol: 'pay_date',
    noun: 'wage payment',
    projectSql: 'project_id',
  },
  contract_payment: {
    table: 'contract_payment',
    dateCol: 'pay_date',
    noun: 'contractor payment',
    projectSql: 'project_id',
  },
};

/** How money left the business: mode and its reference (UTR, UPI or cheque number). */
export const paidSchema = {
  mode: z.enum(PAYMENT_MODES),
  reference: z.string().trim().max(100).nullable().optional(),
};
export const needsReference = (r: { mode: PaymentMode; reference?: string | null | undefined }) =>
  r.mode === 'cash' || (r.reference ?? '').length > 0;
export const REFERENCE_MESSAGE = {
  message: 'Enter the reference (UTR, UPI or cheque number).',
  path: ['reference'],
};
export const amountSchema = z
  .number()
  .int('Amount must be in paise.')
  .positive('Amount must be more than zero.');
export const dateNotFuture = (field: string) =>
  isoDate.refine((d) => d <= todayIn(), {
    message: 'This cannot be dated in the future.',
    path: [field],
  });
export const rejectSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason.').max(500),
});

export const accountFor = (mode: PaymentMode) => ACCOUNT_FOR_MODE[mode];

/** Serialises payroll writes for the company: runs, recoveries and balances never race. */
export async function payrollLock(c: pg.PoolClient): Promise<void> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('payroll:' || app_company_id()::text))`);
}

/** Staff salaries and runs are company-wide: they need the payroll right on all projects. */
export function assertAllProjects(actor: Actor): void {
  if (projectScope(actor) !== null)
    throw new DomainError('FORBIDDEN', 'Staff payroll needs access to all projects.');
}

export interface LockedEntry {
  id: string;
  status: EntryStatus;
  date: IsoDate;
  createdBy: string | null;
  journalId: string | null;
  projectId: string | null;
}

/** Loads a live entry FOR UPDATE; out-of-scope rows read as not found. */
export async function lockEntry(
  c: pg.PoolClient,
  actor: Actor,
  t: EntryTable,
  id: string,
): Promise<LockedEntry> {
  const { rows } = await c.query<{
    id: string;
    status: EntryStatus;
    d: string;
    created_by: string | null;
    journal_id: string | null;
    project_id: string | null;
  }>(
    `SELECT id, status, to_char(${t.dateCol}, 'YYYY-MM-DD') AS d, created_by, journal_id,
            ${t.projectSql} AS project_id
       FROM ${t.table} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [id],
  );
  const r = rows[0];
  const visible =
    r !== undefined &&
    can(actor, 'payroll', 'view', r.project_id ?? undefined) &&
    (r.project_id !== null || projectScope(actor) === null);
  if (!r || !visible) throw new DomainError('NOT_FOUND', `The ${t.noun} was not found.`);
  return {
    id: r.id,
    status: r.status,
    date: r.d,
    createdBy: r.created_by,
    journalId: r.journal_id,
    projectId: r.project_id,
  };
}

export function assertPending(e: LockedEntry, t: EntryTable): void {
  if (e.status !== 'pending')
    throw new DomainError('CONFLICT', `This ${t.noun} is already ${e.status}.`);
}

export async function markApproved(
  c: pg.PoolClient,
  t: EntryTable,
  id: string,
  journalId: string,
): Promise<void> {
  await c.query(
    `UPDATE ${t.table} SET status = 'approved', journal_id = $2, decided_by = app_user_id(),
            decided_at = now() WHERE id = $1`,
    [id, journalId],
  );
  await writeAudit(c, { action: 'approve', entity: t.table, entityId: id });
}

export async function markRejected(
  c: pg.PoolClient,
  t: EntryTable,
  id: string,
  reason: string,
): Promise<void> {
  await c.query(
    `UPDATE ${t.table} SET status = 'rejected', reject_reason = $2, decided_by = app_user_id(),
            decided_at = now() WHERE id = $1`,
    [id, reason],
  );
  await writeAudit(c, { action: 'reject', entity: t.table, entityId: id, after: { reason } });
}

/**
 * Withdraws a pending entry (its author, or `payroll = full`) or, for the Owner only, reverses a
 * posted one in an open period, dated its own date. A rejected entry posted nothing.
 */
export async function removeEntry(
  c: pg.PoolClient,
  actor: Actor,
  t: EntryTable,
  e: LockedEntry,
  narration: string,
): Promise<void> {
  const own = e.status === 'pending' && e.createdBy === actor.userId;
  if (!own) authorize(actor, 'payroll', 'full', e.projectId ?? undefined);
  if (e.status === 'approved' && requiresApproval(actor))
    throw new DomainError('FORBIDDEN', `Only the owner can delete an approved ${t.noun}.`);
  if (e.status === 'rejected')
    throw new DomainError(
      'CONFLICT',
      `A rejected ${t.noun} posts nothing; there is nothing to delete.`,
    );
  const reversal =
    e.status === 'approved' && e.journalId
      ? await reverseJournal(c, e.journalId, e.date, narration)
      : null;
  await c.query(
    `UPDATE ${t.table} SET deleted_at = now(), deleted_by = app_user_id(), reversal_journal_id = $2
      WHERE id = $1`,
    [e.id, reversal],
  );
  await writeAudit(c, {
    action: 'delete',
    entity: t.table,
    entityId: e.id,
    before: { status: e.status },
  });
}

/** Columns every pending-money insert shares, after the entry's own: status and decision. */
export function decision(actor: Actor): { approved: boolean; status: EntryStatus } {
  const approved = !requiresApproval(actor);
  return { approved, status: approved ? 'approved' : 'pending' };
}
