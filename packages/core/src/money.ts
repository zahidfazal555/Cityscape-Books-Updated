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

/**
 * `amount × numerator / denominator`, rounded half away from zero, in exact integer
 * arithmetic (BigInt) so large amounts never lose precision.
 */
export function mulDivHalfUp(amount: Paise, numerator: number, denominator: number): Paise {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError('mulDivHalfUp needs integer numerator and positive integer denominator');
  }
  const product = BigInt(assertPaise(amount)) * BigInt(numerator);
  const den = BigInt(denominator);
  const abs = product < 0n ? -product : product;
  const rounded = (abs * 2n + den) / (den * 2n);
  const result = Number(product < 0n ? -rounded : rounded);
  return assertPaise(result === 0 ? 0 : result); // never -0 (would print as −₹0)
}

/** Converts a percentage with up to 2 decimals (e.g. 9, 2.5, 0.75) to basis points. */
export function toBasisPoints(percent: number): number {
  const bp = Math.round(percent * 100);
  if (!Number.isFinite(percent) || Math.abs(percent * 100 - bp) > 1e-6) {
    throw new RangeError('Percentages may have at most 2 decimals');
  }
  return bp;
}

/** `amount × percent / 100`, rounded half-up to the paisa. `percent` may have up to 2 decimals. */
export function percentOf(amount: Paise, percent: number): Paise {
  return mulDivHalfUp(amount, toBasisPoints(percent), 10_000);
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
