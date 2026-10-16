'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDate, type IsoDate } from '@csd/core';
import { Button, FormError, Input } from '@/components/ui';
import { ApiFailure, apiFetch } from '@/lib/client';

export function LockDateForm({ current }: { current: IsoDate | null }) {
  const router = useRouter();
  const [value, setValue] = useState(current ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(lockDate: string | null) {
    setError(null);
    setSaved(false);
    try {
      await apiFetch('/api/v1/settings/lock-date', { method: 'PUT', body: { lockDate } });
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'Could not update the lock date.');
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px]">
        Currently: <strong>{current ? `locked till ${formatDate(current)}` : 'not locked'}</strong>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="lock" className="sr-only">
          Lock date
        </label>
        <Input id="lock" type="date" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button onClick={() => save(value || null)}>Update lock</Button>
        {current ? (
          <Button variant="ghost" onClick={() => save(null)}>
            Remove lock
          </Button>
        ) : null}
      </div>
      {saved ? <p className="text-[13px] text-success">Lock date updated.</p> : null}
      <FormError message={error} />
    </div>
  );
}
