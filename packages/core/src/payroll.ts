import { DomainError } from './errors.js';
import { assertPaise, mulDivHalfUp, percentOf, type Paise } from './money.js';

/** `YYYY-MM` with a real month. */
export function assertPeriod(period: string, field = 'period'): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  const month = Number(m?.[2]);
  if (!m || month < 1 || month > 12) throw new DomainError('VALIDATION', 'Pick a month.', field);
  return period;
}

/**
 * Tamil Nadu professional tax is levied per half-year and deducted in the September and March
 * runs (SPEC-FIXES C2).
 */
export function isPtMonth(period: string): boolean {
  const month = assertPeriod(period).slice(5, 7);
  return month === '09' || month === '03';
}

export interface PayslipInput {
  gross: Paise;
  /** Fixed monthly TDS on salary, as set on the employee. */
  monthlyTds: Paise;
  /** Half-yearly professional tax. */
  ptHalfYear: Paise;
  /** Monthly instalment the employee repays against advances. */
  recoveryInstalment: Paise;
  /** Approved advances not yet recovered. */
  advanceOutstanding: Paise;
}

export interface Payslip {
  gross: Paise;
  tds: Paise;
  pt: Paise;
  recovery: Paise;
  net: Paise;
}

/**
 * FR-17.1: gross − TDS − PT (Sept/March) − advance recovery = net. Deductions never take the net
 * below zero: TDS first, then PT, then the advance recovery, which never exceeds what is owed.
 */
export function payslipFor(period: string, p: PayslipInput): Payslip {
  for (const [k, v] of Object.entries(p)) assertPaise(v, k);
  if (Object.values(p).some((v) => v < 0))
    throw new DomainError('VALIDATION', 'Payroll amounts cannot be negative.');
  const tds = Math.min(p.monthlyTds, p.gross);
  const pt = isPtMonth(period) ? Math.min(p.ptHalfYear, p.gross - tds) : 0;
  const recovery = Math.min(p.recoveryInstalment, p.advanceOutstanding, p.gross - tds - pt);
  return { gross: p.gross, tds, pt, recovery, net: p.gross - tds - pt - recovery };
}

/** Attendance is kept in tenths of a day (½ day = 5). */
export const DAY = 10;

/** Wages earned for `tenths` of a day at a daily rate, rounded to the paisa. */
export function wagesFor(dailyRate: Paise, tenths: number): Paise {
  if (!Number.isSafeInteger(tenths) || tenths < 0)
    throw new DomainError('VALIDATION', 'Days must be in half days.');
  return mulDivHalfUp(dailyRate, tenths, DAY);
}

/** TDS u/s 194C: 1% for an individual or HUF, 2% for others (or 0 when not deducted). */
export const CONTRACT_TDS_RATES = [0, 1, 2] as const;
export type ContractTdsRate = (typeof CONTRACT_TDS_RATES)[number];

export function contractTds(gross: Paise, rate: ContractTdsRate): Paise {
  return percentOf(gross, rate);
}
