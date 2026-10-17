'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CATEGORY_LABEL, COST_CATEGORIES, formatDate, type Paise } from '@csd/core';
import type { Expense, ExpenseFilter } from '@csd/services';
import { Button, EmptyState, FormError } from '@/components/ui';
import { Drawer, PageHeader, Pill, Row, Table } from '@/components/kit';
import { ExpenseForm } from '@/components/purchases/expense-form';
import { SecureImage } from '@/components/purchases/secure-image';
import { selectCls, useAction, type ProjectOption } from '@/components/sales/use-action';
import { apiFetch } from '@/lib/client';
import { rupees } from '@/lib/format';
import { APPROVAL_STATUS, CATEGORY_DOT, EXPENSE_MODE_LABEL } from '@/lib/purchases';

interface Rights {
  edit: boolean;
  full: boolean;
  owner: boolean;
}

/** FR-11.6: hidden for locked dates and payment-created entries; posted ones are the owner's. */
function canEdit(e: Expense, r: Rights, lockDate: string | null): boolean {
  if (e.source !== 'manual' && e.source !== 'visit') return false;
  if (lockDate !== null && e.txnDate <= lockDate) return false;
  return r.edit && (e.status !== 'approved' || r.owner);
}

function canDelete(e: Expense, r: Rights, lockDate: string | null, me: string): boolean {
  if (e.source !== 'manual' && e.source !== 'visit') return false;
  const neverPosted = e.status !== 'approved';
  if (!neverPosted && lockDate !== null && e.txnDate <= lockDate) return false;
  if (!neverPosted) return r.owner;
  return r.full || e.createdBy === me;
}

function query(f: ExpenseFilter): string {
  const p = new URLSearchParams();
  if (f.projectId) p.set('projectId', f.projectId);
  if (f.category) p.set('category', f.category);
  if (f.status) p.set('status', f.status);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function ExpensesView({
  list,
  filter,
  projects,
  formProjects,
  lockDate,
  me,
  rights,
}: {
  list: { rows: Expense[]; count: number; total: Paise };
  filter: ExpenseFilter;
  projects: ProjectOption[];
  /** Projects new entries may go to (active, on hold). */
  formProjects: ProjectOption[];
  lockDate: string | null;
  me: string;
  rights: Rights;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<{ kind: 'new' } | { kind: 'edit'; e: Expense } | null>(null);
  const [photo, setPhoto] = useState<Expense | null>(null);
  const { error, run } = useAction();
  const go = (patch: Partial<ExpenseFilter>) =>
    router.push(`/expenses${query({ ...filter, ...patch })}`);
  const done = () => {
    setOpen(null);
    router.refresh();
  };
  const remove = (e: Expense) => {
    if (!window.confirm(`Delete "${e.particulars}"?`)) return;
    void run(() => apiFetch(`/api/v1/expenses/${e.id}`, { method: 'DELETE' }));
  };
  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle="Site spends with bill photos. Entries by anyone but the owner wait for approval."
        action={
          <div className="flex gap-2" data-noprint>
            <a
              href={`/api/v1/expenses/export${query(filter)}`}
              className="inline-flex h-9 items-center rounded-md border border-input bg-white px-4 text-[13.5px] font-medium text-primary hover:bg-thead"
            >
              Export CSV
            </a>
            {rights.edit ? (
              <Button onClick={() => setOpen({ kind: 'new' })}>+ Add expense</Button>
            ) : null}
          </div>
        }
      />
      <Filters filter={filter} projects={projects} go={go} count={list.count} total={list.total} />
      <FormError message={error} />
      {list.rows.length === 0 ? (
        <EmptyState>No expenses match.</EmptyState>
      ) : (
        <Table
          columns="0.8fr 0.8fr 1.8fr 1.2fr 0.9fr 0.6fr 1fr 0.5fr 0.9fr 0.8fr 0.9fr"
          minWidth={1220}
        >
          <Row head>
            <span>Date</span>
            <span>Project</span>
            <span>Particulars</span>
            <span>Category</span>
            <span>Paid by</span>
            <span>Mode</span>
            <span>Paid to</span>
            <span>Bill</span>
            <span className="text-right">Amount</span>
            <span>Status</span>
            <span />
          </Row>
          {list.rows.map((e) => (
            <Row key={e.id}>
              <span className="text-muted">{formatDate(e.txnDate)}</span>
              <span className="text-muted">{e.projectCode}</span>
              <span className="min-w-0">
                <span className="block truncate">{e.particulars}</span>
                {e.status === 'rejected' && e.rejectReason ? (
                  <span className="block truncate text-xs text-danger">
                    Rejected: {e.rejectReason}
                  </span>
                ) : null}
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ background: CATEGORY_DOT[e.category] }}
                />
                {CATEGORY_LABEL[e.category]}
              </span>
              <span className="truncate">{e.paidBy}</span>
              <span>{EXPENSE_MODE_LABEL[e.mode]}</span>
              <span className="truncate text-muted">{e.paidTo ?? '—'}</span>
              <span>
                {e.attachmentId ? (
                  <button type="button" className="text-primary" onClick={() => setPhoto(e)}>
                    View
                  </button>
                ) : (
                  <span className="text-subtle">{e.migrated ? 'Imported' : '—'}</span>
                )}
              </span>
              <span className="num text-right">{rupees(e.amount)}</span>
              <span>
                <Pill tone={APPROVAL_STATUS[e.status].tone}>{APPROVAL_STATUS[e.status].label}</Pill>
              </span>
              <span className="flex justify-end gap-2 text-[12.5px]">
                {canEdit(e, rights, lockDate) ? (
                  <button
                    type="button"
                    className="text-primary"
                    onClick={() => setOpen({ kind: 'edit', e })}
                  >
                    Edit
                  </button>
                ) : null}
                {canDelete(e, rights, lockDate, me) ? (
                  <button type="button" className="text-danger" onClick={() => remove(e)}>
                    Delete
                  </button>
                ) : null}
              </span>
            </Row>
          ))}
        </Table>
      )}
      {open ? (
        <Drawer
          title={open.kind === 'new' ? 'New expense' : 'Edit expense'}
          width={560}
          onClose={() => setOpen(null)}
          footer={null}
        >
          <ExpenseForm
            expense={open.kind === 'edit' ? open.e : null}
            projects={formProjects}
            isOwner={rights.owner}
            onDone={done}
            onCancel={() => setOpen(null)}
          />
        </Drawer>
      ) : null}
      {photo?.attachmentId ? (
        <PhotoLightbox
          id={photo.attachmentId}
          type={photo.attachmentType}
          onClose={() => setPhoto(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Bill photo lightbox. Opening it is the audited view (H4). PDFs are offered as a download
 * (BUG-111: chosen from the stored type, never guessed from a load error).
 */
export function PhotoLightbox({
  id,
  type,
  onClose,
}: {
  id: string;
  type: string | null;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(16,24,40,.75)] p-6"
      role="dialog"
      aria-modal
      aria-label="Bill photo"
      onClick={onClose}
    >
      <div
        className="max-h-full max-w-3xl rounded-lg bg-white p-3"
        onClick={(e) => e.stopPropagation()}
      >
        {type === 'application/pdf' ? (
          <p className="p-6 text-[13.5px]">
            This bill is a PDF.{' '}
            <a className="text-primary underline" href={`/api/v1/attachments/${id}`}>
              Download it
            </a>
            .
          </p>
        ) : (
          <SecureImage
            src={`/api/v1/attachments/${id}`}
            alt="Bill photo"
            className="max-h-[80vh] w-auto"
            fallback="Couldn't load the photo. Try again."
          />
        )}
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

function Filters({
  filter,
  projects,
  go,
  count,
  total,
}: {
  filter: ExpenseFilter;
  projects: ProjectOption[];
  go: (patch: Partial<ExpenseFilter>) => void;
  count: number;
  total: Paise;
}) {
  const list = { count, total };
  return (
    <div className="mb-3 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-[12px] text-muted">
        Project
        <select
          className={selectCls}
          value={filter.projectId ?? ''}
          onChange={(e) => go({ projectId: e.target.value || undefined })}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[12px] text-muted">
        Category
        <select
          className={selectCls}
          value={filter.category ?? ''}
          onChange={(e) =>
            go({ category: (e.target.value || undefined) as ExpenseFilter['category'] })
          }
        >
          <option value="">All categories</option>
          {COST_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[12px] text-muted">
        Status
        <select
          className={selectCls}
          value={filter.status ?? ''}
          onChange={(e) => go({ status: (e.target.value || undefined) as ExpenseFilter['status'] })}
        >
          <option value="">All</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </label>
      <p className="ml-auto text-[13px] text-muted" data-testid="expense-summary">
        {list.count} {list.count === 1 ? 'entry' : 'entries'} ·{' '}
        <span className="num font-semibold text-ink">{rupees(list.total)}</span>
      </p>
    </div>
  );
}
