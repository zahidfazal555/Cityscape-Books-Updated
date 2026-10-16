'use client';

import { apiFetch } from '@/lib/client';

export function SignOutButton() {
  return (
    <button
      type="button"
      className="h-8 rounded-md border border-input px-3 text-[13px] text-body hover:bg-thead"
      onClick={async () => {
        await apiFetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
        window.location.assign('/login');
      }}
    >
      Sign out
    </button>
  );
}
