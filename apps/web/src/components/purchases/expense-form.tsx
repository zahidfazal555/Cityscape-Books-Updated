'use client';

import { useState } from 'react';
import {
  CATEGORY_LABEL,
  COST_CATEGORIES,
  parseRupees,
  todayIn,
  type CostCategory,
} from '@csd/core';
import type { Expense, ExpenseMode } from '@csd/services';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Chips } from '@/components/kit';
import { selectCls, useAction, type ProjectOption } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import { toRupeeInput } from '@/lib/format';
import { EXPENSE_MODE_LABEL, OWNER_APPROVAL_NOTE, PAID_BY } from '@/lib/purchases';

const MODES: readonly ExpenseMode[] = ['upi', 'cash', 'bank'];

function initial(e: Expense | null, projects: ProjectOption[], paidBy: string) {
  if (e) {
    return {
      projectId: e.projectId,
      txnDate: e.txnDate,
      amount: toRupeeInput(e.amount),
      particulars: e.particulars,
      category: e.category,
      paidBy: e.paidBy,
      mode: e.mode,
      paidTo: e.paidTo ?? '',
      attachmentId: e.attachmentId,
    };
  }
  return {
    projectId: projects.length === 1 ? (projects[0]?.id ?? '') : '',
    txnDate: todayIn(),
    amount: '',
    particulars: '',
    category: 'material' as CostCategory,
    paidBy,
    mode: 'upi' as ExpenseMode,
    paidTo: '',
    attachmentId: null as string | null,
  };
}

/**
 * Expense entry (README §8 drawer, §17 mobile). The bill photo is uploaded as soon as it is
 * taken, then linked on save. Non-owners see that the entry waits for the owner (H2).
 */
export function ExpenseForm({
  expense = null,
  projects,
  isOwner,
  defaultPaidBy = PAID_BY[0],
  mobile = false,
  onDone,
  onCancel,
}: {
  expense?: Expense | null;
  projects: ProjectOption[];
  isOwner: boolean;
  defaultPaidBy?: string;
  mobile?: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [f, setF] = useState(() => initial(expense, projects, defaultPaidBy));
  const [uploading, setUploading] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, setError, run } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });

  async function upload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const r = await apiFetch<{ id: string }>('/api/v1/attachments', {
        method: 'POST',
        raw: file,
      });
      setF((cur) => ({ ...cur, attachmentId: r.id }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not upload the photo.');
    } finally {
      setUploading(false);
    }
  }

  const save = () =>
    run(async () => {
      const body = {
        projectId: f.projectId,
        txnDate: f.txnDate,
        amount: parseRupees(f.amount || '0', 'amount'),
        particulars: f.particulars,
        category: f.category,
        paidBy: f.paidBy,
        mode: f.mode,
        paidTo: f.paidTo.trim() || null,
        attachmentId: f.attachmentId,
      };
      if (expense)
        return apiFetch(`/api/v1/expenses/${expense.id}`, {
          method: 'PATCH',
          body: { ...body, version: expense.version },
        });
      return apiFetch('/api/v1/expenses', { method: 'POST', idempotencyKey, body });
    }, onDone);

  const big = mobile ? 'min-h-[44px]' : '';
  return (
    <div className="flex flex-col gap-4">
      {isOwner ? null : (
        <p className="rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-[13px] text-warn">
          {OWNER_APPROVAL_NOTE}
        </p>
      )}
      <Field label={mobile ? 'Site' : 'Project'} htmlFor="e-project">
        <select
          id="e-project"
          className={`${selectCls} ${big}`}
          value={f.projectId}
          onChange={set('projectId')}
        >
          <option value="">Choose…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Amount (₹)" htmlFor="e-amount">
        <input
          id="e-amount"
          inputMode="decimal"
          value={f.amount}
          onChange={set('amount')}
          className={`rounded-md border border-input bg-white px-3 outline-none focus:border-primary ${
            mobile ? 'h-14 text-[24px] font-semibold' : 'h-9 text-[13.5px]'
          }`}
        />
      </Field>
      <Field label="What it was for" htmlFor="e-particulars">
        <Input id="e-particulars" value={f.particulars} onChange={set('particulars')} />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-body">Category</span>
        <Chips
          label="Category"
          options={COST_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
          value={f.category}
          onChange={(category) => setF({ ...f, category })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-body">Paid by</span>
        <Chips
          label="Paid by"
          options={PAID_BY.map((p) => ({ value: p, label: p }))}
          value={f.paidBy}
          onChange={(paidBy) => setF({ ...f, paidBy })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-body">Mode</span>
        <Chips
          label="Mode"
          options={MODES.map((m) => ({ value: m, label: EXPENSE_MODE_LABEL[m] }))}
          value={f.mode}
          onChange={(mode) => setF({ ...f, mode })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Paid to" htmlFor="e-paidto">
          <Input id="e-paidto" value={f.paidTo} onChange={set('paidTo')} />
        </Field>
        <Field label="Date" htmlFor="e-date">
          <Input id="e-date" type="date" value={f.txnDate} onChange={set('txnDate')} />
        </Field>
      </div>
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="e-photo"
          className={`flex cursor-pointer items-center justify-center rounded-md border border-dashed px-3 text-[13.5px] font-medium ${
            f.attachmentId
              ? 'border-success bg-success-bg text-success'
              : 'border-dashline text-primary'
          } ${mobile ? 'h-14' : 'h-10'}`}
        >
          {uploading
            ? 'Uploading…'
            : f.attachmentId
              ? 'Bill photo attached ✓ (tap to replace)'
              : 'Take photo of bill (required)'}
        </label>
        <input
          id="e-photo"
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          capture="environment"
          className="sr-only"
          onChange={(e) => void upload(e.target.files?.[0])}
        />
      </div>
      <FormError message={error} />
      <div
        className={mobile ? 'sticky bottom-0 -mx-4 bg-white px-4 py-3' : 'flex justify-end gap-2'}
      >
        {onCancel && !mobile ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          onClick={save}
          disabled={busy || uploading}
          className={mobile ? 'h-14 w-full text-[15px]' : ''}
        >
          {busy ? 'Saving…' : isOwner ? 'Save expense' : 'Submit for approval'}
        </Button>
      </div>
    </div>
  );
}
