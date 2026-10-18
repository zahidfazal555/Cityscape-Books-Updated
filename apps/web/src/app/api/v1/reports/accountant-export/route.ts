import { NextResponse } from 'next/server';
import { strToU8, zipSync } from 'fflate';
import { z } from 'zod';
import { formatDate } from '@csd/core';
import type { AccountantPack } from '@csd/services';
import { istDateTime } from '@/lib/format';
import { api } from '@/lib/http';
import { toCsv } from '@/lib/sales';
import { input } from '@/lib/schemas';
import { services } from '@/lib/server';

const query = z.object({ from: z.string().optional(), to: z.string().optional() });

/** What each file holds, for the README in the ZIP. */
const ABOUT: Record<string, string> = {
  'day-book': 'every journal line in the period (debits equal credits)',
  'trial-balance': 'closing balance of every account on the last day of the period',
  'sales-invoices': 'tax invoices dated in the period, with GST split and status',
  'credit-notes': 'credit notes that cancelled invoices',
  'client-receipts': 'money received from clients, including advances on proformas',
  'purchase-bills': 'vendor bills recorded, with GST split and ITC eligibility',
  'vendor-payments': 'payments to vendors with TDS (pending ones are not yet posted)',
  expenses: 'site and office expenses (pending ones are not yet posted)',
  payroll: 'payslips of payroll runs paid in the period',
  'chart-of-accounts': 'account codes and names used in the day book',
};

function readme(pack: AccountantPack): string {
  return [
    `${pack.company} - books for ${formatDate(pack.from)} to ${formatDate(pack.to)}`,
    `Generated ${istDateTime(new Date().toISOString())} from Cityscape Books.`,
    '',
    'Amounts are in rupees with two decimals; dates are YYYY-MM-DD.',
    'Rows with status "pending" or "rejected" are not in the books yet; the day book has only',
    'posted entries. A reversal (edit or deletion) appears as its own entry pointing to the original.',
    '',
    ...pack.files.map((f) => `${f.name}.csv  ${f.rows.length - 1} rows  ${ABOUT[f.name] ?? ''}`),
    '',
  ].join('\r\n');
}

/**
 * "Export for accountant": the period's books as one ZIP of plain CSV files (owner and auditor).
 * The service checks the rights and writes the export's audit row (H4).
 */
export const GET = api(async ({ actor, req }) => {
  const range = input(query, Object.fromEntries(req.nextUrl.searchParams));
  const pack = await services().accountantExport.pack(actor, range);
  // The byte-order mark lets Excel read ₹, – and Tamil names as UTF-8.
  const files = Object.fromEntries(
    pack.files.map((f) => [`${f.name}.csv`, strToU8(`\uFEFF${toCsv(f.rows)}`)]),
  );
  const zip = zipSync({ ...files, 'README.txt': strToU8(readme(pack)) }, { level: 6 });
  return new NextResponse(new Uint8Array(zip), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="books-${pack.from}-to-${pack.to}.zip"`,
    },
  });
});
