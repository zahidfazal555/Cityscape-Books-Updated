import { z } from 'zod';
import { toDecimalString } from '@csd/core';
import { exportFormat, exportResponse } from '@/lib/export-response';
import { api } from '@/lib/http';
import { INVOICE_STATUS } from '@/lib/sales';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({
  status: z.enum(['unpaid', 'partially_paid', 'paid', 'overdue', 'cancelled']).optional(),
});

/** CSV or PDF of the invoice list (README §5). The service writes the export's audit row (H4). */
export const GET = api(async ({ actor, req }) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const q = input(query, params);
  const { format } = input(exportFormat, params);
  const invoices = await services().invoices.export(actor, { status: q.status }, format);
  const title = q.status ? `Tax invoices · ${INVOICE_STATUS[q.status].label}` : 'Tax invoices';
  return exportResponse(actor, format, 'tax-invoices', { title }, [
    ['Number', 'Date', 'Due', 'Client', 'Project', 'Tax type', 'Total', 'Balance due', 'Status'],
    ...invoices.map((i) => [
      i.number,
      i.invoiceDate,
      i.dueDate,
      i.clientName,
      i.projectCode,
      i.interState ? 'IGST' : 'CGST+SGST',
      toDecimalString(i.total),
      toDecimalString(i.balance),
      INVOICE_STATUS[i.status].label,
    ]),
  ]);
});
