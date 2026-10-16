import { mulDivHalfUp, percentOf, toBasisPoints, type Paise } from './money.js';

export const COMPANY_STATE_CODE = '33';
export const DEFAULT_SAC = '9954';
export const GST_RATES = [0, 5, 12, 18, 28] as const;
export type GstRate = (typeof GST_RATES)[number];

export interface TaxSplit {
  interState: boolean;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
}

/**
 * FR-3.2.1 / FR-3.2.2: same state → CGST + SGST at half the rate each; otherwise IGST.
 * Computed per line and rounded to the paisa (SPEC-FIXES A6).
 */
export function splitTax(
  taxable: Paise,
  rate: number,
  placeOfSupply: string,
  companyStateCode = COMPANY_STATE_CODE,
): TaxSplit {
  const interState = placeOfSupply !== companyStateCode;
  if (interState) return { interState, cgst: 0, sgst: 0, igst: percentOf(taxable, rate) };
  const half = percentOf(taxable, rate / 2);
  return { interState, cgst: half, sgst: half, igst: 0 };
}

/**
 * Tax contained in a GST-inclusive amount (advances, Table 11A): amount × r / (100 + r).
 * SPEC-FIXES A7: uses the document's rate, not a hard-coded 18%.
 */
export function taxInInclusive(amount: Paise, rate: number): Paise {
  if (rate === 0) return 0;
  const basisPoints = toBasisPoints(rate);
  return mulDivHalfUp(amount, basisPoints, 10_000 + basisPoints);
}
