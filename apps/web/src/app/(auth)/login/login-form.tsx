'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiFailure, apiFetch, safeNext } from '@/lib/client';
import { Button, Field, FormError, Input } from '@/components/ui';

export function LoginForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/v1/auth/login', {
        method: 'POST',
        body: { email: form.get('email'), password: form.get('password') },
      });
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiFailure ? err.message : 'Could not sign in. Check your connection.',
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <h2 className="text-[22px] font-semibold text-ink">Sign in</h2>
      <Field label="Work email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>
      <FormError message={error} />
      <Button type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
      <Link href="/forgot-password" className="text-[13px] text-primary hover:underline">
        Forgot password?
      </Link>
      <p className="text-xs text-muted">
        Sign in with your work email and password. Sessions end after 30 minutes idle.
      </p>
    </form>
  );
}
