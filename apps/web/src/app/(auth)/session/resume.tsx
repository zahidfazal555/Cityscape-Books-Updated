'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { safeNext } from '@/lib/client';

/** Silent session refresh before showing an app page; falls back to sign-in. */
export function ResumeSession() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  useEffect(() => {
    fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' })
      .then((r) =>
        router.replace(r.ok || r.status === 409 ? next : `/login?next=${encodeURIComponent(next)}`),
      )
      .catch(() => router.replace(`/login?next=${encodeURIComponent(next)}`));
  }, [next, router]);
  return <p className="text-[13.5px] text-muted">Restoring your session…</p>;
}
