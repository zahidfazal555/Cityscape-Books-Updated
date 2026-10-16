import { publicApi } from '@/lib/http';
import { limits } from '@/lib/rate-limit';
import { input, tokenAndPassword } from '@/lib/schemas';
import { services } from '@/lib/server';

export const POST = publicApi(async ({ body, client }) => {
  limits.tokenRedeem.take(`ip:${client.ip ?? 'unknown'}`);
  const { token, password } = input(tokenAndPassword, body);
  await services().auth.redeemToken(token, 'reset', password);
});
