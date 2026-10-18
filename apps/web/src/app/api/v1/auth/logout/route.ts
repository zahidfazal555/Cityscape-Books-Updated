import { NextResponse } from 'next/server';
import { COOKIE, clearSessionCookies, publicApi } from '@/lib/http';
import { services } from '@/lib/server';

export const POST = publicApi(async ({ req }) => {
  const token = req.cookies.get(COOKIE.refresh)?.value;
  if (token) await services().auth.logout(token);
  return clearSessionCookies(new NextResponse(null, { status: 204 }));
});
