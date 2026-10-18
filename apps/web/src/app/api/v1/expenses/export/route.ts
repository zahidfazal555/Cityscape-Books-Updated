import { NextResponse } from 'next/server';
import { CATEGORY_LABEL, toDecimalString } from '@csd/core';
import { api } from '@/lib/http';
import { toCsv } from '@/lib/sales';
import { expenseQuery, input } from '@/lib/schemas';
import { services } from '@/lib/server';

/** CSV of the filtered expenses (FR-11.1). The service writes the export's audit row (H4). */
export const GET = api(async ({ actor, req }) => {
  const q = input(expenseQuery, Object.fromEntries(req.nextUrl.searchParams));
  const rows = await services().expenses.export(actor, q);
  const csv = toCsv([
    [
      'Date',
      'Project',
      'Particulars',
      'Category',
      'Paid by',
      'Mode',
      'Paid to',
      'Amount',
      'Status',
    ],
    ...rows.map((e) => [
      e.txnDate,
      e.projectCode,
      e.particulars,
      CATEGORY_LABEL[e.category],
      e.paidBy,
      e.mode.toUpperCase(),
      e.paidTo ?? '',
      toDecimalString(e.amount),
      e.status,
    ]),
  ]);
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="expenses.csv"',
    },
  });
});
