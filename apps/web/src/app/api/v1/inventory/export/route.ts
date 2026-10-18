import { z } from 'zod';
import { toDecimalString } from '@csd/core';
import { exportFormat, exportResponse } from '@/lib/export-response';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ projectId: z.string().uuid().optional() });

/** "Export CSV" / PDF (FR-18.2); the service writes the audit row (H4). */
export const GET = api(async ({ actor, req }) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const q = input(query, params);
  const { format } = input(exportFormat, params);
  const rows = await services().inventory.export(actor, q, format);
  return exportResponse(actor, format, 'material-purchases', { title: 'Material purchases' }, [
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
