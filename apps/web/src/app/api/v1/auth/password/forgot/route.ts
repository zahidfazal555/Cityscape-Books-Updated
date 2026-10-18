import { ipKey, publicApi } from '@/lib/http';
import { limits } from '@/lib/rate-limit';
import { emailOnly, input } from '@/lib/schemas';
import { services } from '@/lib/server';

/** Always 204, whether or not the account exists. Limited per address and per IP. */
export const POST = publicApi(async ({ body, client }) => {
  const { email } = input(emailOnly, body);
  limits.resetIp.take(ipKey(client.ip));
  limits.resetEmail.take(`email:${email.toLowerCase()}`);
  await services().auth.requestPasswordReset(email);
});
