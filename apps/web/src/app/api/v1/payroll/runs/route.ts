import type { RunInput } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api(async ({ actor }) => services().payroll.runs(actor));
/** "Process payroll" (FR-17.1); pending for non-owners (H2). */
export const POST = api(async ({ actor, body }) =>
  services().payroll.process(actor, body as RunInput),
);
