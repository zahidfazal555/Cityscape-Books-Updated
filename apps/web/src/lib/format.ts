import { formatInr, toDecimalString, type Paise } from '@csd/core';

/** ₹ with en-IN grouping, without paise when they are zero (tables and cards). */
export function rupees(paise: Paise): string {
  const s = formatInr(paise);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
}

/** Paise → editable rupees text ("1250000" or "1250000.50"). */
export function toRupeeInput(paise: Paise): string {
  return toDecimalString(paise).replace(/\.00$/, '');
}

const IST_DATETIME = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});
const IST_DATETIME_SECONDS = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'Asia/Kolkata',
});
const IST_DATE_ISO = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const IST_HOUR = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  hour12: false,
  timeZone: 'Asia/Kolkata',
});

/** "14 Oct 2026, 09:02 am" in India time. */
export const istDateTime = (iso: string | null): string =>
  iso ? IST_DATETIME.format(new Date(iso)) : '—';
export const istDateTimeSeconds = (iso: string): string =>
  IST_DATETIME_SECONDS.format(new Date(iso));
/** The IST calendar date of an instant, as YYYY-MM-DD. */
export const istDate = (d: Date): string => IST_DATE_ISO.format(d);
export const istHour = (d: Date = new Date()): number => Number(IST_HOUR.format(d));
/** "Access ends on" a date means through the end of that day in India. */
export const endOfIstDay = (date: string): string => `${date}T23:59:59+05:30`;

export const STATUS_LABEL = {
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
} as const;
export const STATUS_TONE = {
  active: 'green',
  on_hold: 'amber',
  completed: 'blue',
  cancelled: 'grey',
} as const;
