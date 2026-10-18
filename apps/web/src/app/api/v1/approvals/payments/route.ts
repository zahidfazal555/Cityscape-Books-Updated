import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** The owner's queue of vendor payments waiting for approval (H2). */
export const GET = api(async ({ actor }) => services().vendorPayments.pending(actor));
