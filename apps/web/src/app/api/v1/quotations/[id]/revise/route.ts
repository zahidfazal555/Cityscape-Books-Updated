import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Keeps the number, stores the current version in history, increments the revision (FR-5.4). */
export const POST = api<{ id: string }>(async ({ actor, params }) =>
  services().quotations.revise(actor, params.id),
);
