import { DomainError } from './errors.js';

/** GST state codes (first two digits of a GSTIN). */
export const STATE_CODES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

const PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The GSTN check character for the first 14 characters. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = ALPHABET.indexOf(first14.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(value / 36) + (value % 36);
  }
  return ALPHABET.charAt((36 - (sum % 36)) % 36);
}

/**
 * FR-3.2.4: format, check digit, a known state code, and (when given) the state chosen
 * on the contact must match the GSTIN's first two digits. Returns the normalised GSTIN.
 */
export function validateGstin(raw: string, expectedStateCode?: string, field = 'gstin'): string {
  const gstin = raw.trim().toUpperCase();
  if (!PATTERN.test(gstin)) {
    throw new DomainError('VALIDATION', 'GSTIN format is not valid.', field);
  }
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin.charAt(14)) {
    throw new DomainError('VALIDATION', 'GSTIN check digit is wrong. Check for a typo.', field);
  }
  const stateCode = gstin.slice(0, 2);
  if (!(stateCode in STATE_CODES)) {
    throw new DomainError('VALIDATION', 'GSTIN state code is not valid.', field);
  }
  if (expectedStateCode !== undefined && expectedStateCode !== stateCode) {
    throw new DomainError(
      'VALIDATION',
      `GSTIN starts with ${stateCode} but the state chosen is ${STATE_CODES[expectedStateCode] ?? expectedStateCode}.`,
      field,
    );
  }
  return gstin;
}
