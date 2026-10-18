import { NextResponse } from 'next/server';
import { z } from 'zod';
import { toDecimalString } from '@csd/core';
import { api } from '@/lib/http';
import { INVOICE_STATUS, toCsv } from '@/lib/sales';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({
  status: z.enum(['unpaid', 'partially_paid', 'paid', 'overdue', 'cancelled']).optional(),
});

/** CSV of the invoice list (README §5). The service writes the export's audit row (H4). */
export const GET = api(async ({ actor, req }) => {
  const q = input(query, Object.fromEntries(req.nextUrl.searchParams));
  const invoices = await services().invoices.export(actor, { status: q.status });
  const csv = toCsv([
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
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="tax-invoices.csv"',
    },
  });
});
