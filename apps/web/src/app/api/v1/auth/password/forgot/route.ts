import { publicApi } from '@/lib/http';
import { limits } from '@/lib/rate-limit';
import { emailOnly, input } from '@/lib/schemas';
import { services } from '@/lib/server';

/** Always 204, whether or not the account exists. Limited per address and per IP. */
export const POST = publicApi(async ({ body, client }) => {
  const { email } = input(emailOnly, body);
  limits.resetIp.take(`ip:${client.ip ?? 'unknown'}`);
  limits.resetEmail.take(`email:${email.toLowerCase()}`);
  await services().auth.requestPasswordReset(email);
});
