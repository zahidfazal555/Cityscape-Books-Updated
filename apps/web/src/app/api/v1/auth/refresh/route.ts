import { NextResponse } from 'next/server';
import { DomainError } from '@csd/core';
import { COOKIE, clearSessionCookies, publicApi, withDevice, withSessionCookies } from '@/lib/http';
import { services } from '@/lib/server';

export const POST = publicApi(async ({ req, client: raw }) => {
  const token = req.cookies.get(COOKIE.refresh)?.value;
  if (!token) throw new DomainError('UNAUTHENTICATED', 'Please sign in.');
  const { client, newDevice } = withDevice(raw);
  try {
    const tokens = await services().auth.refresh(token, client);
    return withSessionCookies(NextResponse.json({ ok: true }), tokens, newDevice);
  } catch (error) {
    // 409 = another tab rotated first: keep cookies, the browser already has (or will get) new ones.
    if (error instanceof DomainError && error.status === 401) {
      return clearSessionCookies(NextResponse.json({ error: error.toJSON() }, { status: 401 }));
    }
    throw error;
  }
});
