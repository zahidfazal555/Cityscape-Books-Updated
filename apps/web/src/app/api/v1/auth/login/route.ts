import { NextResponse } from 'next/server';
import { ipKey, publicApi, withDevice, withSessionCookies } from '@/lib/http';
import { limits } from '@/lib/rate-limit';
import { credentials, input } from '@/lib/schemas';
import { services } from '@/lib/server';

export const POST = publicApi(async ({ body, client: raw }) => {
  limits.login.take(ipKey(raw.ip));
  const { email, password } = input(credentials, body);
  const { client, newDevice } = withDevice(raw);
  const tokens = await services().auth.login(email, password, client);
  return withSessionCookies(NextResponse.json({ ok: true }), tokens, newDevice);
});
