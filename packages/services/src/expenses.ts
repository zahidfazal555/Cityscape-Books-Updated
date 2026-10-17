import { randomUUID } from 'node:crypto';
import {
  ACCOUNT_FOR_MODE,
  CATEGORY_ACCOUNT,
  COST_CATEGORIES,
  DomainError,
  assertApprover,
  assertId,
  assertNotLocked,
  authorize,
  can,
  fromDecimalString,
  projectScope,
  requiresApproval,
  toDecimalString,
  todayIn,
  type Actor,
  type CostCategory,
  type IsoDate,
  type Paise,
} from '@csd/core';
import { postJournal, reverseJournal, withTenant, writeAudit } from '@csd/db';
import type pg from 'pg';
import { z } from 'zod';
import { claimAttachment } from './attachments.js';
import { assertLiveProject } from './purchase-orders.js';
import { companyRow, isoDate, parse, tenantOf as ctx } from './validation.js';

export const EXPENSE_MODES = ['upi', 'cash', 'bank'] as const;
export type ExpenseMode = (typeof EXPENSE_MODES)[number];
export const EXPENSE_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];
/** CSV exports stop here rather than cutting rows silently. */
export const EXPORT_MAX = 50_000;

export type ExpenseSource = 'manual' | 'payroll_wage' | 'contract_payment' | 'visit';

const fields = {
  projectId: z.string().uuid('Choose a project.'),
  txnDate: isoDate,
  amount: z.number().int('Amount must be in paise.').positive('Amount must be more than zero.'),
  particulars: z.string().trim().min(1, 'Say what it was for.').max(300),
  category: z.enum(COST_CATEGORIES),
  paidBy: z.string().trim().min(1, 'Who paid?').max(80),
  mode: z.enum(EXPENSE_MODES),
  paidTo: z.string().trim().max(120).nullable().optional(),
  attachmentId: z.string().uuid().nullable().optional(),
};
const expenseSchema = z.object(fields);
const updateSchema = z.object({ ...fields, version: z.number().int().positive() });
const rejectSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason.').max(500) });
/** As many as the queue shows (pending() returns at most 500); BUG-112. */
const bulkSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

export type ExpenseInput = z.input<typeof expenseSchema>;
export type ExpenseUpdate = z.input<typeof updateSchema>;

export interface Expense {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  txnDate: IsoDate;
  particulars: string;
  category: CostCategory;
  amount: Paise;
  paidBy: string;
  mode: ExpenseMode;
  paidTo: string | null;
  attachmentId: string | null;
  /** Lets the viewer choose image or download without guessing (BUG-111). */
  attachmentType: string | null;
  migrated: boolean;
  source: ExpenseSource;
  status: ExpenseStatus;
  rejectReason: string | null;
  submittedBy: string | null;
  createdBy: string | null;
  submittedAt: string;
  version: number;
}

export interface ExpenseFilter {
  projectId?: string | undefined;
  category?: CostCategory | undefined;
  status?: ExpenseStatus | undefined;
  /** Only the caller's own entries (site engineer home; BUG-118). */
  mine?: boolean | undefined;
}

const SELECT = `
  SELECT e.id, e.project_id, p.code AS project_code, p.name AS project_name,
         to_char(e.txn_date, 'YYYY-MM-DD') AS txn_date, e.particulars, e.category, e.amount::text, e.paid_by,
         e.mode, e.paid_to, e.attachment_id, e.migrated, e.source, e.status, e.reject_reason,
         u.name AS submitted_by, e.created_by, e.created_at, e.version, e.journal_id,
         at.content_type AS attachment_type
    FROM expense e
    JOIN project p ON p.id = e.project_id
    LEFT JOIN app_user u ON u.id = e.created_by
    LEFT JOIN attachment at ON at.id = e.attachment_id
   WHERE e.deleted_at IS NULL`;

/** $1 scope, $2 project, $3 category, $4 status, $5 only mine. */
const FILTER = `
     AND ($1::uuid[] IS NULL OR e.project_id = ANY($1::uuid[]))
     AND ($2::uuid IS NULL OR e.project_id = $2)
     AND ($3::text IS NULL OR e.category = $3)
     AND ($4::text IS NULL OR e.status = $4)
     AND (NOT $5 OR e.created_by = app_user_id())`;

interface Row {
  id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  txn_date: string;
  particulars: string;
  category: CostCategory;
  amount: string;
  paid_by: string;
  mode: ExpenseMode;
  paid_to: string | null;
  attachment_id: string | null;
  migrated: boolean;
  source: ExpenseSource;
  status: ExpenseStatus;
  reject_reason: string | null;
  submitted_by: string | null;
  created_by: string | null;
  created_at: Date;
  version: number;
  journal_id: string | null;
  attachment_type: string | null;
}

const toExpense = (r: Row): Expense => ({
  id: r.id,
  projectId: r.project_id,
  projectCode: r.project_code,
  projectName: r.project_name,
  txnDate: r.txn_date,
  particulars: r.particulars,
  category: r.category,
  amount: fromDecimalString(r.amount),
  paidBy: r.paid_by,
  mode: r.mode,
  paidTo: r.paid_to,
  attachmentId: r.attachment_id,
  attachmentType: r.attachment_type,
  migrated: r.migrated,
  source: r.source,
  status: r.status,
  rejectReason: r.reject_reason,
  submittedBy: r.submitted_by,
  createdBy: r.created_by,
  submittedAt: r.created_at.toISOString(),
  version: r.version,
});

const params = (actor: Actor, f: ExpenseFilter) => [
  projectScope(actor),
  f.projectId ?? null,
  f.category ?? null,
  f.status ?? null,
  f.mine ?? false,
];

/**
 * Site expenses (Req §4.11, §4.12). H2: an expense entered by anyone but the Owner is Pending and
 * posts nothing; the Owner approves (Dr project cost / Cr cash, bank or UPI) or rejects it.
 */
export class ExpensesService {
  constructor(private readonly pool: pg.Pool) {}

  /** Filtered rows (newest 500) with the live count and total over every match (FR-11.1). */
  async list(
    actor: Actor,
    filter: ExpenseFilter = {},
  ): Promise<{ rows: Expense[]; count: number; total: Paise }> {
    authorize(actor, 'expenses', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Row>(
        `${SELECT} ${FILTER} ORDER BY e.txn_date DESC, e.created_at DESC LIMIT 500`,
        params(actor, filter),
      );
      const sum = await c.query<{ count: string; total: string }>(
        `SELECT count(*)::text AS count, coalesce(sum(e.amount), 0)::text AS total
           FROM expense e WHERE e.deleted_at IS NULL ${FILTER}`,
        params(actor, filter),
      );
      return {
        rows: rows.map(toExpense),
        count: Number(sum.rows[0]?.count ?? 0),
        total: fromDecimalString(sum.rows[0]?.total ?? '0'),
      };
    });
  }

  /** Every match for a CSV download; H4: the export writes an audit row. */
  async export(actor: Actor, filter: ExpenseFilter = {}): Promise<Expense[]> {
    authorize(actor, 'expenses', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Row>(
        `${SELECT} ${FILTER} ORDER BY e.txn_date DESC, e.created_at DESC LIMIT ${EXPORT_MAX + 1}`,
        params(actor, filter),
      );
      if (rows.length > EXPORT_MAX) {
        throw new DomainError(
          'VALIDATION',
          `More than ${EXPORT_MAX.toLocaleString('en-IN')} rows. Filter by project or status first.`,
        );
      }
      await writeAudit(c, {
        action: 'export',
        entity: 'expense',
        entityId: null,
        after: { format: 'csv', filter, rows: rows.length },
      });
      return rows.map(toExpense);
    });
  }

  /** The Owner's queue (Approvals → Expenses), oldest first. */
  async pending(actor: Actor): Promise<Expense[]> {
    assertApprover(actor);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const { rows } = await c.query<Row>(
        `${SELECT} AND e.status = 'pending' ORDER BY e.created_at LIMIT 500`,
      );
      return rows.map(toExpense);
    });
  }

  async get(actor: Actor, id: string): Promise<Expense> {
    assertId(id, 'Expense');
    authorize(actor, 'expenses', 'view');
    return withTenant(this.pool, ctx(actor), async (c) => toExpense(await loadRow(c, actor, id)));
  }

  /** Records an expense: Pending for non-owners, posted at once for the Owner. */
  async create(actor: Actor, input: ExpenseInput): Promise<{ id: string; status: ExpenseStatus }> {
    const data = parse(expenseSchema, input);
    assertProject(actor, data.projectId);
    assertNotFuture(data.txnDate);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const company = await companyRow(c);
      assertNotLocked(data.txnDate, company.lock_date, 'txnDate');
      await assertLiveProject(c, data.projectId);
      await assertPhoto(c, data.attachmentId ?? null);
      const id = randomUUID();
      if (data.attachmentId) await claimAttachment(c, actor, data.attachmentId, id);
      const approved = !requiresApproval(actor);
      const journalId = approved ? await postExpense(c, id, data) : null;
      await c.query(
        `INSERT INTO expense (id, company_id, project_id, txn_date, particulars, category, amount, paid_by, mode,
                              paid_to, account_code, attachment_id, status, decided_by, decided_at, journal_id,
                              created_by, updated_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 CASE WHEN $13 THEN app_user_id() END, CASE WHEN $13 THEN now() END, $14, app_user_id(),
                 app_user_id())`,
        [
          id,
          data.projectId,
          data.txnDate,
          data.particulars,
          data.category,
          toDecimalString(data.amount),
          data.paidBy,
          data.mode,
          data.paidTo ?? null,
          ACCOUNT_FOR_MODE[data.mode],
          data.attachmentId ?? null,
          approved ? 'approved' : 'pending',
          approved,
          journalId,
        ],
      );
      await writeAudit(c, {
        action: 'create',
        entity: 'expense',
        entityId: id,
        after: { ...data, status: approved ? 'approved' : 'pending' },
      });
      return { id, status: approved ? 'approved' : 'pending' };
    });
  }

  /**
   * FR-11.6: edits a manual expense in an open period. Only the Owner edits an approved one (it is
   * reversed and reposted); others edit pending or rejected entries, which (re)submits them.
   * `attachmentId`: omitted keeps the photo, null removes it (only where no photo is required).
   */
  async update(actor: Actor, id: string, input: ExpenseUpdate): Promise<{ status: ExpenseStatus }> {
    assertId(id, 'Expense');
    const data = parse(updateSchema, input);
    authorize(actor, 'expenses', 'edit');
    assertNotFuture(data.txnDate);
    return withTenant(this.pool, ctx(actor), async (c) => {
      const before = await loadRow(c, actor, id, true);
      authorize(actor, 'expenses', 'edit', before.project_id);
      assertProject(actor, data.projectId);
      assertEditable(before, data.version);
      // BUG-104 (H2): un-posting an approved entry is itself a change to the books; only the
      // Owner corrects one. Others record a new entry or ask the Owner.
      if (before.status === 'approved' && requiresApproval(actor)) {
        throw new DomainError(
          'FORBIDDEN',
          'This expense is approved. Only the owner can change it.',
        );
      }
      const company = await companyRow(c);
      assertNotLocked(before.txn_date, company.lock_date, 'txnDate');
      assertNotLocked(data.txnDate, company.lock_date, 'txnDate');
      await checkEdit(c, actor, before, data);
      if (before.journal_id)
        await reverseJournal(c, before.journal_id, before.txn_date, 'Expense edited: reversal');
      const approved = !requiresApproval(actor);
      const journalId = approved ? await postExpense(c, id, data) : null;
      await c.query(
        `UPDATE expense SET project_id = $2, txn_date = $3, particulars = $4, category = $5, amount = $6,
                paid_by = $7, mode = $8, paid_to = $9, account_code = $10, attachment_id = $11, status = $12,
                decided_by = CASE WHEN $13 THEN app_user_id() END, decided_at = CASE WHEN $13 THEN now() END,
                reject_reason = NULL, journal_id = $14, version = version + 1, updated_by = app_user_id()
          WHERE id = $1`,
        [
          id,
          data.projectId,
          data.txnDate,
          data.particulars,
          data.category,
          toDecimalString(data.amount),
          data.paidBy,
          data.mode,
          data.paidTo ?? null,
          ACCOUNT_FOR_MODE[data.mode],
          data.attachmentId === undefined ? before.attachment_id : data.attachmentId,
          approved ? 'approved' : 'pending',
          approved,
          journalId,
        ],
      );
      const status: ExpenseStatus = approved ? 'approved' : 'pending';
      await writeAudit(c, {
        action: 'update',
        entity: 'expense',
        entityId: id,
        before: toExpense(before),
        after: { ...data, status },
      });
      return { status };
    });
  }

  /**
   * FR-11.6: deletes a manual expense (`expenses = full`, or its author while Pending). A posted
   * one is reversed, and only the Owner does that (H2). Pending ones can be withdrawn after the
   * month is locked; posted ones cannot be deleted then.
   */
  async remove(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Expense');
    authorize(actor, 'expenses', 'edit');
    await withTenant(this.pool, ctx(actor), async (c) => {
      const e = await loadRow(c, actor, id, true);
      if (e.source !== 'manual' && e.source !== 'visit')
        throw new DomainError('CONFLICT', 'This entry was created by a payment; change it there.');
      // Never-posted entries (pending or rejected) can be withdrawn by their author.
      const own = e.status !== 'approved' && e.created_by === actor.userId;
      if (!own) authorize(actor, 'expenses', 'full', e.project_id);
      if (e.status === 'approved' && requiresApproval(actor))
        throw new DomainError('FORBIDDEN', 'Only the owner can delete an approved expense.');
      const reversal = e.journal_id
        ? await reverseJournal(c, e.journal_id, e.txn_date, 'Expense deleted')
        : null;
      await c.query(
        `UPDATE expense SET deleted_at = now(), deleted_by = app_user_id(), reversal_journal_id = $2 WHERE id = $1`,
        [id, reversal],
      );
      await writeAudit(c, {
        action: 'delete',
        entity: 'expense',
        entityId: id,
        before: { particulars: e.particulars, amount: e.amount, status: e.status },
      });
    });
  }

  /** The Owner approves; the expense posts on its own date (open period only). */
  async approve(actor: Actor, id: string): Promise<void> {
    assertId(id, 'Expense');
    assertApprover(actor);
    await withTenant(this.pool, ctx(actor), (c) => approveTx(c, actor, id));
  }

  /** "Approve all": each one in its own transaction, so one locked-period entry blocks no others. */
  async approveMany(
    actor: Actor,
    input: z.input<typeof bulkSchema>,
  ): Promise<{ approved: string[]; failed: { id: string; message: string }[] }> {
    const { ids } = parse(bulkSchema, input);
    assertApprover(actor);
    const approved: string[] = [];
    const failed: { id: string; message: string }[] = [];
    for (const id of ids) {
      try {
        await withTenant(this.pool, ctx(actor), (c) => approveTx(c, actor, id));
        approved.push(id);
      } catch (e) {
        // Earlier ones are committed: always report, never fail the whole batch.
        failed.push({
          id,
          message: e instanceof DomainError ? e.message : 'Could not approve this entry.',
        });
      }
    }
    return { approved, failed };
  }

  async reject(actor: Actor, id: string, input: z.input<typeof rejectSchema>): Promise<void> {
    assertId(id, 'Expense');
    const data = parse(rejectSchema, input);
    assertApprover(actor);
    await withTenant(this.pool, ctx(actor), async (c) => {
      const e = await loadRow(c, actor, id, true);
      if (e.status !== 'pending')
        throw new DomainError('CONFLICT', `This expense is already ${e.status}.`);
      await c.query(
        `UPDATE expense SET status = 'rejected', reject_reason = $2, decided_by = app_user_id(), decided_at = now()
          WHERE id = $1`,
        [id, data.reason],
      );
      await writeAudit(c, {
        action: 'reject',
        entity: 'expense',
        entityId: id,
        after: { reason: data.reason },
      });
    });
  }
}

/** A moved project must be open; the photo rule (B6) holds; a new photo is claimed. */
async function checkEdit(
  c: pg.PoolClient,
  actor: Actor,
  before: Row,
  data: { projectId: string; attachmentId?: string | null | undefined },
): Promise<void> {
  if (data.projectId !== before.project_id) await assertLiveProject(c, data.projectId);
  const photo = data.attachmentId === undefined ? before.attachment_id : data.attachmentId;
  if (needsPhoto(before)) await assertPhoto(c, photo);
  if (data.attachmentId && data.attachmentId !== before.attachment_id)
    await claimAttachment(c, actor, data.attachmentId, before.id, before.created_by);
}

/** B6: the photo rule applies to manual entries that were not imported from the old trackers. */
const needsPhoto = (e: Pick<Row, 'source' | 'migrated'>) => e.source === 'manual' && !e.migrated;

async function approveTx(c: pg.PoolClient, actor: Actor, id: string): Promise<void> {
  const e = await loadRow(c, actor, id, true);
  if (e.status !== 'pending')
    throw new DomainError('CONFLICT', `This expense is already ${e.status}.`);
  const company = await companyRow(c);
  assertNotLocked(e.txn_date, company.lock_date, 'txnDate');
  // The project may have closed, or the photo rule changed, since it was entered.
  // BUG-154: service visits happen after handover, on Completed projects.
  await assertLiveProject(c, e.project_id, e.source === 'visit');
  if (needsPhoto(e)) await assertPhoto(c, e.attachment_id);
  const journalId = await postExpense(c, id, {
    projectId: e.project_id,
    txnDate: e.txn_date,
    amount: fromDecimalString(e.amount),
    category: e.category,
    mode: e.mode,
    particulars: e.particulars,
  });
  await c.query(
    `UPDATE expense SET status = 'approved', journal_id = $2, decided_by = app_user_id(), decided_at = now()
      WHERE id = $1`,
    [id, journalId],
  );
  await writeAudit(c, { action: 'approve', entity: 'expense', entityId: id });
}

/** Dr project cost (category account) / Cr cash, bank or UPI. */
function postExpense(
  c: pg.PoolClient,
  id: string,
  e: {
    projectId: string;
    txnDate: IsoDate;
    amount: Paise;
    category: CostCategory;
    mode: ExpenseMode;
    particulars: string;
  },
): Promise<string> {
  return postJournal(c, {
    txnDate: e.txnDate,
    sourceType: 'expense',
    sourceId: id,
    narration: `Expense: ${e.particulars}`.slice(0, 300),
    lines: [
      { accountCode: CATEGORY_ACCOUNT[e.category], debit: e.amount, projectId: e.projectId },
      { accountCode: ACCOUNT_FOR_MODE[e.mode], credit: e.amount, projectId: e.projectId },
    ],
  });
}

async function loadRow(
  c: pg.PoolClient,
  actor: Actor,
  id: string,
  forUpdate = false,
): Promise<Row> {
  const { rows } = await c.query<Row>(
    `${SELECT} AND e.id = $1${forUpdate ? ' FOR UPDATE OF e' : ''}`,
    [id],
  );
  const r = rows[0];
  if (!r || !can(actor, 'expenses', 'view', r.project_id))
    throw new DomainError('NOT_FOUND', 'Expense not found.');
  return r;
}

function assertProject(actor: Actor, projectId: string): void {
  authorize(actor, 'expenses', 'edit');
  if (!can(actor, 'expenses', 'view', projectId))
    throw new DomainError('NOT_FOUND', 'Project not found.');
  authorize(actor, 'expenses', 'edit', projectId);
}

function assertEditable(e: Row, version: number): void {
  if (e.version !== version) {
    throw new DomainError(
      'CONFLICT',
      'This expense was changed by someone else. Reload it and try again.',
    );
  }
  if (e.source !== 'manual' && e.source !== 'visit')
    throw new DomainError('CONFLICT', 'This entry was created by a payment; change it there.');
}

/** FR-11.5 / B6: a bill photo is required while the company flag is on. */
async function assertPhoto(c: pg.PoolClient, attachmentId: string | null): Promise<void> {
  if (attachmentId) return;
  const { rows } = await c.query<{ required: boolean }>(
    'SELECT require_bill_attachment AS required FROM company',
  );
  if (rows[0]?.required)
    throw new DomainError('VALIDATION', 'Add a photo of the bill.', 'attachmentId');
}

function assertNotFuture(d: IsoDate): void {
  if (d > todayIn())
    throw new DomainError('VALIDATION', 'An expense cannot be dated in the future.', 'txnDate');
}
