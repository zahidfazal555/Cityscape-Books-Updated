import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Support → Site visits: every visit in scope, scheduled first. */
export const GET = api(async ({ actor }) => services().visits.list(actor));
