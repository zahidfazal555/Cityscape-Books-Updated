import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** The site engineer's own visits (mobile home). */
export const GET = api(async ({ actor }) => services().visits.mine(actor));
