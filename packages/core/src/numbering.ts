import { financialYear, type IsoDate } from './dates.js';

/** Requirements §3.1 document series. `fy: true` series restart every financial year. */
export const SERIES = {
  project: { prefix: 'CSD-PRJ-', fy: false, pad: 4 },
  quote: { prefix: 'QT/', fy: true, pad: 4 },
  proforma: { prefix: 'PI/', fy: true, pad: 4 },
  invoice: { prefix: 'CSD/', fy: true, pad: 4 },
  creditNote: { prefix: 'CN/', fy: true, pad: 4 },
  receipt: { prefix: 'RCT/', fy: true, pad: 4 },
  purchaseOrder: { prefix: 'PO/', fy: true, pad: 4 },
  ticket: { prefix: 'TKT-', fy: false, pad: 4 },
} as const;
export type Series = keyof typeof SERIES;

/** The `fy` key under which a series counter is stored ('-' for non-FY series). */
export function seriesPeriod(series: Series, docDate: IsoDate, fyStartMonth = 4): string {
  return SERIES[series].fy ? financialYear(docDate, fyStartMonth) : '-';
}

/** CSD/26-27/0001, CSD-PRJ-0001 … */
export function formatDocNumber(series: Series, period: string, value: number): string {
  const s = SERIES[series];
  const n = String(value).padStart(s.pad, '0');
  return s.fy ? `${s.prefix}${period}/${n}` : `${s.prefix}${n}`;
}
