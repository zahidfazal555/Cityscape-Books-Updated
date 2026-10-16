'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/client';

/** Only the server can clear httpOnly cookies: if logout fails, say so and stay signed in visibly. */
export function SignOutButton() {
  const [failed, setFailed] = useState(false);
  return (
    <span className="flex items-center gap-2">
      {failed ? (
        <span role="alert" className="text-xs text-danger">
          Sign-out failed. Check your connection and try again.
        </span>
      ) : null}
      <button
        type="button"
        className="h-8 rounded-md border border-input px-3 text-[13px] text-body hover:bg-thead"
        onClick={async () => {
          try {
            await apiFetch('/api/v1/auth/logout', { method: 'POST' });
            window.location.assign('/login');
          } catch {
            setFailed(true);
          }
        }}
      >
        Sign out
      </button>
    </span>
  );
}
