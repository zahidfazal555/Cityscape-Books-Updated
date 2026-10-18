import { z } from 'zod';
import { AGEING_LABEL, formatDate, toDecimalString } from '@csd/core';
import { exportFormat, exportResponse } from '@/lib/export-response';
import { api } from '@/lib/http';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

/** CSV or PDF of receivables or payables; the service audits the export (H4). */
export const GET = api<{ side: string }>(async ({ actor, params, req }) => {
  const side = input(z.enum(['receivables', 'payables']), params.side);
  const { format } = input(exportFormat, Object.fromEntries(req.nextUrl.searchParams));
  const data = await services().outstanding.export(actor, side, format);
  const title =
    side === 'receivables' ? 'Receivables (client outstanding)' : 'Payables (vendor outstanding)';
  return exportResponse(
    actor,
    format,
    side,
    { title, subtitle: `As on ${formatDate(data.asOf)}` },
    [
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
    ],
  );
});
