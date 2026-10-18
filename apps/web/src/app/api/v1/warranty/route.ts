import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Warranty register (FR-20.1). */
export const GET = api(async ({ actor }) => services().warranty.register(actor));
