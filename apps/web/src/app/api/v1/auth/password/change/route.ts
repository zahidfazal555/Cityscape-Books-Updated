import { NextResponse } from 'next/server';
import { api, clearSessionCookies } from '@/lib/http';
import { changePassword, input } from '@/lib/schemas';
import { services } from '@/lib/server';

/** Changing the password signs out every session, this one included. */
export const POST = api(async ({ actor, body, client }) => {
  const { currentPassword, newPassword } = input(changePassword, body);
  await services().auth.changePassword(actor, currentPassword, newPassword, client);
  return clearSessionCookies(new NextResponse(null, { status: 204 }));
});
