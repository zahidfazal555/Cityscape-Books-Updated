import type { AcceptInput } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Accepts and creates (or links) the project (FR-5.5, FR-5.7). */
export const POST = api<{ id: string }>(async ({ actor, params, body }) =>
  services().quotations.accept(actor, params.id, body as AcceptInput),
);
