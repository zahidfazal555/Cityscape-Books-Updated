import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** The Owner's queue: pending expenses, vendor payments and quotation discounts (H2). */
export const GET = api(async ({ actor }) => services().approvals.queue(actor));
