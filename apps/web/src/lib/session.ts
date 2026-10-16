import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { DomainError, type Actor } from '@csd/core';
import { COOKIE } from './http';
import { services } from './server';

/** Server-side session for pages. No valid access token → silent refresh, then sign-in. */
export async function requireActor(): Promise<Actor> {
  const token = (await cookies()).get(COOKIE.access)?.value;
  const path = (await headers()).get('x-pathname') ?? '/';
  if (!token) redirect(`/session?next=${encodeURIComponent(path)}`);
  try {
    return (await services().auth.authenticate(token)).actor;
  } catch (error) {
    if (error instanceof DomainError && error.status === 401)
      redirect(`/session?next=${encodeURIComponent(path)}`);
    throw error;
  }
}
