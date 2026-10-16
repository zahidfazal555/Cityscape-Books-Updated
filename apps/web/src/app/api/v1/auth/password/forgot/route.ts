import { publicApi } from '@/lib/http';
import { emailOnly, input } from '@/lib/schemas';
import { services } from '@/lib/server';

/** Always 204, whether or not the account exists. */
export const POST = publicApi(async ({ body }) => {
  await services().auth.requestPasswordReset(input(emailOnly, body).email);
});
