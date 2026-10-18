import { z } from 'zod';
import { AGEING_LABEL, toDecimalString } from '@csd/core';
import { csvResponse } from '@/lib/csv-response';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

/** CSV of receivables or payables; the service audits the export (H4). */
export const GET = api<{ side: string }>(async ({ actor, params }) => {
  const side = input(z.enum(['receivables', 'payables']), params.side);
  const data = await services().outstanding.export(actor, side);
  return csvResponse(side, [
    [
      'Number',
      side === 'receivables' ? 'Client' : 'Vendor',
      'Project',
      'Date',
      'Due',
      'Total',
      'Balance',
      'Days overdue',
      'Bucket',
    ],
    ...data.rows.map((r) => [
      r.number,
      r.partyName,
      r.projectCode,
      r.docDate,
      r.dueDate,
      toDecimalString(r.total),
      toDecimalString(r.balance),
      r.daysOverdue,
      AGEING_LABEL[r.bucket],
    ]),
  ]);
});
