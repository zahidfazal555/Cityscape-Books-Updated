'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { safeNext } from '@/lib/redirect';

const refresh = () => fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Silent session refresh before showing an app page. A 409 means another tab (or a lost
 * response) rotated the token: wait and retry once with whatever cookie the browser now has;
 * if that does not produce a session, go to sign-in rather than loop.
 */
export function ResumeSession() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  useEffect(() => {
    const toLogin = () => router.replace(`/login?next=${encodeURIComponent(next)}`);
    (async () => {
      let res = await refresh();
      if (res.status === 409) {
        await wait(1500);
        res = await refresh();
      }
      if (res.ok) router.replace(next);
      else toLogin();
    })().catch(toLogin);
  }, [next, router]);
  return <p className="text-[13.5px] text-muted">Restoring your session…</p>;
}
