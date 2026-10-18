import type { JobInput } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api(async ({ actor }) => services().labour.jobs(actor));
/** H2: a non-owner's job value waits for the Owner. */
export const POST = api(async ({ actor, body }) =>
  services().labour.createJob(actor, body as JobInput),
);
