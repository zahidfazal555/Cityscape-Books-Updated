import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Owner only: an account's opening balance (FR-13.1). */
export const POST = api(async ({ actor, body }) => {
  await services().banking.setOpening(
    actor,
    body as { code: '1000'; amount: number; asOf: string },
  );
});
