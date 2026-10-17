import { toDecimalString } from '@csd/core';
import { csvResponse } from '@/lib/csv-response';
import { api } from '@/lib/http';
import { services } from '@/lib/server';

/** GSTR-1 rows as CSV (FR-15.6), audited (H4). */
export const GET = api<{ period: string }>(async ({ actor, params }) => {
  const m = await services().gst.month(actor, params.period);
  const rows = [
    ...m.invoices.flatMap((i) =>
      i.items.map(
        (it) =>
          [
            'Invoice',
            i.number,
            i.date,
            i.ctin ?? 'B2C',
            i.pos,
            it.rate,
            it.taxable,
            it.tax,
          ] as const,
      ),
    ),
    ...m.creditNotes.flatMap((n) =>
      n.items.map(
        (it) =>
          [
            'Credit note',
            n.number,
            n.date,
            n.ctin ?? 'B2C',
            n.pos,
            it.rate,
            -it.taxable,
            { igst: -it.tax.igst, cgst: -it.tax.cgst, sgst: -it.tax.sgst },
          ] as const,
      ),
    ),
  ];
  await services().reports.recordExport(actor, 'gstr1-csv', rows.length);
  return csvResponse(`GSTR1-${params.period}`, [
    [
      'Type',
      'Number',
      'Date',
      'GSTIN',
      'Place of supply',
      'Rate',
      'Taxable',
      'IGST',
      'CGST',
      'SGST',
    ],
    ...rows.map(([type, no, date, ctin, pos, rate, taxable, tax]) => [
      type,
      no,
      date,
      ctin,
      pos,
      rate,
      toDecimalString(taxable),
      toDecimalString(tax.igst),
      toDecimalString(tax.cgst),
      toDecimalString(tax.sgst),
    ]),
  ]);
});
