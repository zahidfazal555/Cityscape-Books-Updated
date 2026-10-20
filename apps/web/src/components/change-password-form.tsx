'use client';

import { useState } from 'react';
import { Button, Field, FormError, Input } from '@/components/ui';
import { ApiFailure, apiFetch } from '@/lib/client';

/**
 * Change your own password: current password, then the new one twice. Success ends every session,
 * this one included, so the browser goes to sign-in.
 */
export function ChangePasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== again) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await apiFetch('/api/v1/auth/password/change', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      window.location.assign('/login');
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Could not change the password.');
      setBusy(false);
    }
  }

  const type = show ? 'text' : 'password';
  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <Field label="Current password" htmlFor="cp-current">
        <Input
          id="cp-current"
          type={type}
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </Field>
      <Field
        label="New password"
        htmlFor="cp-new"
        hint="At least 12 characters. Not a known breached password, and not your name or email."
      >
        <Input
          id="cp-new"
          type={type}
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
      </Field>
      <Field label="New password again" htmlFor="cp-again">
        <Input
          id="cp-again"
          type={type}
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          required
        />
      </Field>
      <label className="flex items-center gap-2 text-[13px] text-body">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
        Show passwords
      </label>
      <FormError message={error} />
      <div>
        <Button type="submit" disabled={busy || !current || !next || !again}>
          {busy ? 'Saving…' : 'Change password'}
        </Button>
      </div>
    </form>
  );
}
