import { DomainError } from './errors.js';

/**
 * Money is integer paise in code (safe integers only) and NUMERIC(14,2) in the database.
 * Never use floating-point rupees for arithmetic.
 */
export type Paise = number;

const MAX_PAISE = 99_999_999_999_999; // NUMERIC(14,2) upper bound

export function assertPaise(value: number, field = 'amount'): Paise {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_PAISE) {
    throw new DomainError('VALIDATION', 'Amount is out of range.', field);
  }
  return value;
}

/** Parses "1,23,456.7" or "123456.70" (rupees) into paise. Rejects more than 2 decimals. */
export function parseRupees(input: string, field = 'amount'): Paise {
  const cleaned = input.replace(/[,\s₹]/g, '');
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) throw new DomainError('VALIDATION', 'Enter a valid amount.', field);
  const [, sign, whole = '0', frac = ''] = match;
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return assertPaise(sign ? -paise : paise, field);
}

/** Paise → "12345.67" for NUMERIC columns. */
export function toDecimalString(paise: Paise): string {
  assertPaise(paise);
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** "12345.67" from a NUMERIC column → paise. */
export function fromDecimalString(value: string): Paise {
  return parseRupees(value);
}

/** Rounds half away from zero, the way Indian tax amounts are rounded. */
export function roundHalfUp(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** `amount × percent / 100`, rounded half-up to the paisa. `percent` may have up to 2 decimals. */
export function percentOf(amount: Paise, percent: number): Paise {
  const basisPoints = Math.round(percent * 100);
  return assertPaise(roundHalfUp((amount * basisPoints) / 10_000));
}

/** Document totals are rounded to the nearest rupee; the difference is posted as round-off. */
export function roundToRupee(total: Paise): { total: Paise; roundOff: Paise } {
  const rounded = roundHalfUp(total / 100) * 100;
  return { total: rounded, roundOff: rounded - total };
}

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** ₹1,00,000.00 */
export function formatInr(paise: Paise): string {
  return INR.format(paise / 100);
}

/** ₹4.50 L / ₹1.20 Cr for KPI cards. */
export function formatInrShort(paise: Paise): string {
  const rupees = paise / 100;
  const abs = Math.abs(rupees);
  if (abs >= 1e7) return `₹${(rupees / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `₹${(rupees / 1e5).toFixed(2)} L`;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(rupees);
}
