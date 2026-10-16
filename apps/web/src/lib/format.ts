import { formatInr, type Paise } from '@csd/core';

/** ₹ with en-IN grouping, without paise when they are zero (tables and cards). */
export function rupees(paise: Paise): string {
  const s = formatInr(paise);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
}

/** Paise → editable rupees text ("1250000" or "1250000.50"). */
export function toRupeeInput(paise: Paise): string {
  const r = Math.trunc(paise / 100);
  const p = Math.abs(paise % 100);
  return p ? `${r}.${String(p).padStart(2, '0')}` : String(r);
}

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
