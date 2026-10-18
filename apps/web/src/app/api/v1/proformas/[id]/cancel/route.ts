import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Cancels (never deletes) a proforma with no advances (FR-6.6). */
export const POST = api<{ id: string }>(async ({ actor, params }) => {
  await services().proformas.cancel(actor, params.id);
});
