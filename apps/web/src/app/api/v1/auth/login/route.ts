import { NextResponse } from 'next/server';
import { publicApi, withSessionCookies } from '@/lib/http';
import { credentials, input } from '@/lib/schemas';
import { services } from '@/lib/server';

export const POST = publicApi(async ({ body, client }) => {
  const { email, password } = input(credentials, body);
  const tokens = await services().auth.login(email, password, client);
  return withSessionCookies(NextResponse.json({ ok: true }), tokens, client.deviceId ?? null);
});
