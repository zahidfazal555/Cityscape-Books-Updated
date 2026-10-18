'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiFailure } from '@/lib/client';

/** Runs one server action at a time, shows its error, and refreshes the page on success. */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>, then?: (result: unknown) => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (then) then(result);
      else router.refresh();
    } catch (e) {
      setError(e instanceof ApiFailure || e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

export const selectCls =
  'h-9 w-full rounded-md border border-input bg-white px-2 text-[13.5px] text-ink outline-none focus:border-primary';

export const textareaCls =
  'min-h-[72px] w-full rounded-md border border-input bg-white px-3 py-2 text-[13.5px] text-ink outline-none focus:border-primary';

export interface ProjectOption {
  id: string;
  code: string;
  name: string;
  clientName: string;
  clientStateCode: string;
}
