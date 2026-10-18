import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** The signed-in user's notifications (the header bell). */
export const GET = api(async ({ actor }) => services().notifications.mine(actor));
