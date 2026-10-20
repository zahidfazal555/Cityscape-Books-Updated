import { api } from '@/lib/http';
import { input, setUserPassword } from '@/lib/schemas';
import { services } from '@/lib/server';

/** Owner-only: set a user's password; they are signed out everywhere. Audited. */
export const POST = api<{ id: string }>(async ({ actor, params, body, client }) => {
  const { password } = input(setUserPassword, body);
  await services().auth.setPasswordFor(actor, params.id, password, client);
});
