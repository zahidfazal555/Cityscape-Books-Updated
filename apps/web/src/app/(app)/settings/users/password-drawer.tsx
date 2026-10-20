'use client';

import { useState } from 'react';
import { Button, Field, FormError, Input } from '@/components/ui';
import { Drawer } from '@/components/kit';
import { ApiFailure, apiFetch } from '@/lib/client';

/**
 * Owner sets another user's password from Users & access: typed twice; the user is signed out
 * everywhere. The owner's own password is changed on /account/password (current one required).
 */
export function PasswordDrawer({
  user,
  onClose,
  onSaved,
}: {
  user: { id: string; name: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (next !== again) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/api/v1/users/${user.id}/password`, {
        method: 'POST',
        body: { password: next },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'Could not set the password.');
      setBusy(false);
    }
  }

  const type = show ? 'text' : 'password';
  return (
    <Drawer
      title={`Set password · ${user.name}`}
      width={440}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !next}>
            {busy ? 'Saving…' : 'Set password'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">
          {user.name} is signed out everywhere and any invite or reset link stops working. Share the
          password with them privately; they can change it under Change password in the top bar.
        </p>
        <Field
          label="New password"
          htmlFor="pw-new"
          hint="At least 12 characters. Not a known breached password, and not their name or email."
        >
          <Input
            id="pw-new"
            type={type}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label="New password again" htmlFor="pw-again">
          <Input
            id="pw-again"
            type={type}
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-[13px] text-body">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          Show passwords
        </label>
        <FormError message={error} />
      </div>
    </Drawer>
  );
}
