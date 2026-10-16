import { publicApi } from '@/lib/http';
import { input, tokenAndPassword } from '@/lib/schemas';
import { services } from '@/lib/server';

export const POST = publicApi(async ({ body }) => {
  const { token, password } = input(tokenAndPassword, body);
  await services().auth.redeemToken(token, 'invite', password);
});
