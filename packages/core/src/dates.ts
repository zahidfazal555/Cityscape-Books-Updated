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

/** Today's business date in the company's time zone (India by default), as YYYY-MM-DD. */
export function todayIn(timeZone = 'Asia/Kolkata', now: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Calendar arithmetic on ISO dates (no time zones involved). */
export function addDays(value: IsoDate, days: number): IsoDate {
  const { y, m, d } = parseIsoDate(value);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** A return period 'YYYY-MM' → its first and last dates. */
export function monthRange(period: string): { from: IsoDate; to: IsoDate } {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) throw new RangeError('Period must be YYYY-MM');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
}
