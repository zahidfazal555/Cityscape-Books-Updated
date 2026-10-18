import type { ScheduleInput } from '@csd/services';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

export const GET = api<{ id: string }>(async ({ actor, params }) =>
  services().visits.list(actor, params.id),
);
/** "Schedule site visit" (FR-19.9). */
export const POST = api<{ id: string }>(async ({ actor, params, body }) =>
  services().visits.schedule(actor, params.id, body as ScheduleInput),
);
