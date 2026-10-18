import { CATEGORY_LABEL, toDecimalString } from '@csd/core';
import { exportFormat, exportResponse } from '@/lib/export-response';
import { api } from '@/lib/http';
import { expenseQuery, input } from '@/lib/schemas';
import { services } from '@/lib/server';

/** CSV or PDF of the filtered expenses (FR-11.1). The service writes the export's audit row (H4). */
export const GET = api(async ({ actor, req }) => {
  const params = Object.fromEntries(req.nextUrl.searchParams);
  const q = input(expenseQuery, params);
  const { format } = input(exportFormat, params);
  const rows = await services().expenses.export(actor, q, format);
  return exportResponse(actor, format, 'expenses', { title: 'Expenses' }, [
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
});
