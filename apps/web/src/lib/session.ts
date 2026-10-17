import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { DomainError, type Actor, type IsoDate } from '@csd/core';
import { COOKIE } from './http';
import { services } from './server';

export interface PageSession {
  actor: Actor;
  name: string;
  company: { name: string; lockDate: IsoDate | null; fyStartMonth: number; stateCode: string };
}

/**
 * Server-side session for pages, computed once per request (layout and page share it).
 * No valid access token → silent refresh, then sign-in.
 */
export const getSession = cache(async (): Promise<PageSession> => {
  const token = (await cookies()).get(COOKIE.access)?.value;
  const path = (await headers()).get('x-pathname') ?? '/';
  const resume = `/session?next=${encodeURIComponent(path)}`;
  if (!token) redirect(resume);
  let actor: Actor;
  try {
    actor = (await services().auth.authenticate(token)).actor;
  } catch (error) {
    if (error instanceof DomainError && error.status === 401) redirect(resume);
    throw error;
  }
  const [me, company] = await Promise.all([
    services().users.me(actor),
    services().settings.companyInfo(actor),
  ]);
  return { actor, name: me.name, company };
});
