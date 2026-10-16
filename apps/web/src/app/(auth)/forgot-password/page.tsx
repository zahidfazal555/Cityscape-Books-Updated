'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { apiFetch } from '@/lib/client';
import { Button, Field, FormError, Input } from '@/components/ui';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/v1/auth/password/forgot', {
        method: 'POST',
        body: { email: new FormData(e.currentTarget).get('email') },
      });
      setSent(true);
    } catch {
      setError('Could not send the request. Try again.');
    }
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-[22px] font-semibold">Check your email</h2>
        <p className="text-[13.5px] text-body">
          If an account exists for that address, a reset link is on its way. It works once, for 24
          hours.
        </p>
        <Link href="/login" className="text-[13px] text-primary hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <h2 className="text-[22px] font-semibold">Reset your password</h2>
      <Field label="Work email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <FormError message={error} />
      <Button type="submit">Email me a reset link</Button>
      <Link href="/login" className="text-[13px] text-primary hover:underline">
        Back to sign in
      </Link>
    </form>
  );
}
