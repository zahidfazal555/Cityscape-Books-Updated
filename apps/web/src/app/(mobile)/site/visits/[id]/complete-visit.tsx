'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CATEGORY_LABEL, COST_CATEGORIES, parseRupees, type CostCategory } from '@csd/core';
import { Button, Field, FormError, Input } from '@/components/ui';
import { selectCls, textareaCls, useAction } from '@/components/sales/use-action';
import { apiFetch, newIdempotencyKey } from '@/lib/client';
import { downscale } from '@/lib/downscale';

type Phase = 'before' | 'after' | 'bill';

/**
 * FR-23.4/23.5: before photos and after photos (required, several at once, from the camera or
 * gallery, downscaled), what was done (required), and an optional cost with a bill photo.
 */
export function CompleteVisit({ visitId }: { visitId: string }) {
  const router = useRouter();
  const [photos, setPhotos] = useState<Record<Phase, string[]>>({
    before: [],
    after: [],
    bill: [],
  });
  const [uploading, setUploading] = useState<Phase | null>(null);
  const [workDone, setWorkDone] = useState('');
  const [cost, setCost] = useState('');
  const [category, setCategory] = useState<CostCategory>('site_visit');
  const [mode, setMode] = useState<'cash' | 'upi' | 'bank'>('cash');
  const [idempotencyKey] = useState(newIdempotencyKey);
  const { busy, error, setError, run } = useAction();

  async function add(phase: Phase, files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(phase);
    setError(null);
    try {
      const ids: string[] = [];
      for (const file of Array.from(files)) {
        const raw = await downscale(file);
        const r = await apiFetch<{ id: string }>('/api/v1/attachments', { method: 'POST', raw });
        ids.push(r.id);
      }
      setPhotos((p) => ({
        ...p,
        [phase]: phase === 'bill' ? ids.slice(-1) : [...p[phase], ...ids],
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not upload the photo.');
    } finally {
      setUploading(null);
    }
  }

  const hasCost = cost.trim() !== '';
  const save = () =>
    run(
      () =>
        apiFetch(`/api/v1/visits/${visitId}/complete`, {
          method: 'POST',
          idempotencyKey,
          body: {
            beforeIds: photos.before,
            afterIds: photos.after,
            workDone,
            ...(hasCost
              ? {
                  cost: parseRupees(cost.trim(), 'cost'),
                  category,
                  mode,
                  billPhotoId: photos.bill[0] ?? null,
                }
              : {}),
          },
        }),
      () => {
        router.push('/site');
        router.refresh();
      },
    );

  const picker = (phase: Phase, label: string, multiple: boolean) => (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={`ph-${phase}`}
        className={`flex h-14 cursor-pointer items-center justify-center rounded-lg border border-dashed px-3 text-[15px] font-medium ${
          photos[phase].length > 0
            ? 'border-success bg-success-bg text-success'
            : 'border-dashline text-primary'
        }`}
      >
        {uploading === phase
          ? 'Uploading…'
          : photos[phase].length > 0
            ? `${label}: ${photos[phase].length} added ✓ (tap to add more)`
            : label}
      </label>
      <input
        id={`ph-${phase}`}
        type="file"
        accept="image/jpeg,image/png"
        multiple={multiple}
        className="sr-only"
        onChange={(e) => {
          void add(phase, e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );

  return (
    <section className="flex flex-col gap-4">
      {picker('before', 'Before photos (required)', true)}
      {picker('after', 'After photos (required)', true)}
      <Field label="What was done (required)" htmlFor="v-work">
        <textarea
          id="v-work"
          className={textareaCls}
          value={workDone}
          onChange={(e) => setWorkDone(e.target.value)}
        />
      </Field>
      <Field label="Cost (₹, optional)" htmlFor="v-cost" hint="Goes to the owner for approval.">
        <Input
          id="v-cost"
          inputMode="decimal"
          className="h-12"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
        />
      </Field>
      {hasCost ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category" htmlFor="v-cat">
              <select
                id="v-cat"
                className={`${selectCls} h-12`}
                value={category}
                onChange={(e) => setCategory(e.target.value as CostCategory)}
              >
                {COST_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Paid by" htmlFor="v-mode">
              <select
                id="v-mode"
                className={`${selectCls} h-12`}
                value={mode}
                onChange={(e) => setMode(e.target.value as 'cash' | 'upi' | 'bank')}
              >
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="bank">Bank</option>
              </select>
            </Field>
          </div>
          {picker('bill', 'Photo of the bill (required for a cost)', false)}
        </>
      ) : null}
      <FormError message={error} />
      <Button className="h-14 text-[16px]" onClick={save} disabled={busy || uploading !== null}>
        {busy ? 'Saving…' : 'Complete visit'}
      </Button>
    </section>
  );
}
