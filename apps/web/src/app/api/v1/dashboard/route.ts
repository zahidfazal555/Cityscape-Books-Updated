import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Tech Spec `GET /dashboard`: KPIs, alerts, project rows, category split, ageing. */
export const GET = api(async ({ actor }) => services().dashboard.summary(actor));
