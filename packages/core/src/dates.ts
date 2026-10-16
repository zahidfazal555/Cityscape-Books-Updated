import { DomainError } from './errors.js';

/** ISO calendar date, `YYYY-MM-DD`. All business dates are dates, not timestamps. */
export type IsoDate = string;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseIsoDate(value: string, field = 'date'): { y: number; m: number; d: number } {
  const match = ISO.exec(value);
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d) {
      return { y, m, d };
    }
  }
  throw new DomainError('VALIDATION', 'Enter a valid date.', field);
}

/** "14 Oct 2026" */
export function formatDate(value: IsoDate): string {
  const { y, m, d } = parseIsoDate(value);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
}

/**
 * Indian financial year label for a date, e.g. 2026-10-14 → "26-27".
 * `startMonth` is the company's FY start (April = 4).
 */
export function financialYear(value: IsoDate, startMonth = 4): string {
  const { y, m } = parseIsoDate(value);
  const startYear = m >= startMonth ? y : y - 1;
  const yy = (n: number): string => String(n % 100).padStart(2, '0');
  return startMonth === 1 ? yy(startYear) : `${yy(startYear)}-${yy(startYear + 1)}`;
}
