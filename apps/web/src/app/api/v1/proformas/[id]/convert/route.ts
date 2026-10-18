import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Issues the tax invoice and moves the advances onto it (FR-6.5). */
export const POST = api<{ id: string }>(async ({ actor, params, body }) =>
  services().proformas.convert(
    actor,
    params.id,
    body as { invoiceDate?: string; dueDate?: string },
  ),
);
