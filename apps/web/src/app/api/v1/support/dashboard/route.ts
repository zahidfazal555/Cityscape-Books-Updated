import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Support dashboard (FR-19.12). */
export const GET = api(async ({ actor }) => services().supportDashboard.get(actor));
