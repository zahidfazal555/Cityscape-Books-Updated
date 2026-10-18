import type { CompanyUpdate } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api(async ({ actor }) => services().settings.get(actor));
/** Company details printed on documents (Settings → Company): owner-only. */
export const PATCH = api(async ({ actor, body }) => {
  await services().settings.updateCompany(actor, body as CompanyUpdate);
});
