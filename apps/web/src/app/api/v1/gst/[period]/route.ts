import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** GSTR-3B summary, GSTR-1 tables, advances and ITC register for a month (FR-15). */
export const GET = api<{ period: string }>(async ({ actor, params }) =>
  services().gst.month(actor, params.period),
);
