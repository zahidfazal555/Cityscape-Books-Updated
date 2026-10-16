'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiFailure, apiFetch } from '@/lib/client';
import { Button, Field, FormError, Input } from '@/components/ui';
import { useHydrated } from '@/lib/use-hydrated';

/** Shared by "accept invite" and "reset password": both set a password from an emailed link. */
export function SetPasswordForm({ purpose }: { purpose: 'invite' | 'reset' }) {
  const token = useSearchParams().get('token') ?? '';
  const [done, setDone] = useState(false);
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get('password') !== form.get('confirm')) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const path =
        purpose === 'invite' ? '/api/v1/auth/invite/accept' : '/api/v1/auth/password/reset';
      await apiFetch(path, { method: 'POST', body: { token, password: form.get('password') } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Could not save the password. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-[22px] font-semibold">Password saved</h2>
        <p className="text-[13.5px] text-body">You can now sign in with your new password.</p>
        <Link href="/login" className="text-[13px] text-primary hover:underline">
          Go to sign in
        </Link>
      </div>
    );
  }
  return (
    <form method="post" onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <h2 className="text-[22px] font-semibold">
        {purpose === 'invite' ? 'Set up your account' : 'Choose a new password'}
      </h2>
      <Field
        label="New password"
        htmlFor="password"
        hint="At least 12 characters. Avoid your name or email; a short phrase works well."
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          autoFocus
        />
      </Field>
      <Field label="Confirm password" htmlFor="confirm">
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </Field>
      <FormError
        message={
          token ? error : 'This link is missing its token. Open the link from your email again.'
        }
      />
      <Button type="submit" disabled={busy || !token || !hydrated}>
        {busy ? 'Saving…' : 'Save password'}
      </Button>
    </form>
  );
}
