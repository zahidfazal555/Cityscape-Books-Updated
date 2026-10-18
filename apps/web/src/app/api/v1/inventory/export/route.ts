import { z } from 'zod';
import { toDecimalString } from '@csd/core';
import { csvResponse } from '@/lib/csv-response';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ projectId: z.string().uuid().optional() });

/** "Export CSV" (FR-18.2); the service writes the audit row (H4). */
export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  const rows = await services().inventory.export(actor, q);
  return csvResponse('material-purchases', [
    ['Date', 'Project', 'Item', 'Category', 'Quantity', 'Unit', 'Amount', 'Average rate', 'Vendor'],
    ...rows.map((m) => [
      m.purchaseDate,
      m.projectCode,
      m.item,
      m.category,
      (m.qtyMilli / 1000).toString(),
      m.unit,
      toDecimalString(m.amount),
      toDecimalString(m.averageRate),
      m.vendorName,
    ]),
  ]);
});
