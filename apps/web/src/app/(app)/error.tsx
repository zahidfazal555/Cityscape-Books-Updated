'use client';

import { Button } from '@/components/ui';

/** Any unexpected failure inside the app shell: a plain message instead of a blank 500 (BUG-133). */
export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div role="alert" className="rounded-lg border border-line bg-white p-6 text-[13.5px]">
      <h1 className="mb-1 text-[17px] font-semibold">This page could not load</h1>
      <p className="mb-4 text-muted">
        Check the link or try again. If it keeps happening, tell the owner.
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
