import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** Cash, bank and UPI balances with unmatched counts (FR-13.1). */
export const GET = api(async ({ actor }) => services().banking.accounts(actor));
