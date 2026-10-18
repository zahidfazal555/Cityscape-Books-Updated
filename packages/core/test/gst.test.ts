import { describe, expect, it } from 'vitest';
import {
  DomainError,
  GST_RATES,
  gstinCheckChar,
  splitTax,
  taxInInclusive,
  validateGstin,
} from '../src/index.js';

const make = (first14: string): string => first14 + gstinCheckChar(first14);
const TN = make('33AAHCH2210K1Z');
const KA = make('29AAKFV7731M1Z');

describe('GSTIN (FR-3.2.4)', () => {
  it('accepts a valid GSTIN and normalises case', () => {
    expect(validateGstin(` ${TN.toLowerCase()} `, '33')).toBe(TN);
  });

  it('matches the check digit of the GST portal sample GSTIN', () => {
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V');
    expect(validateGstin('27AAPFU0939F1ZV', '27')).toBe('27AAPFU0939F1ZV');
  });

  it('rejects bad format, bad check digit, unknown state and state mismatch', () => {
    expect(() => validateGstin('33AAHCH2210K1Y4')).toThrow('format');
    const wrongCheck = TN.slice(0, 14) + (TN.endsWith('0') ? '1' : '0');
    expect(() => validateGstin(wrongCheck)).toThrow('check digit');
    expect(() => validateGstin(make('99AAHCH2210K1Z'))).toThrow('state code');
    expect(() => validateGstin(KA, '33')).toThrow(
      'starts with 29 but the state chosen is Tamil Nadu',
    );
  });

  it('raises a 422 on the gstin field', () => {
    try {
      validateGstin('bad');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect(e).toMatchObject({ status: 422, field: 'gstin' });
    }
  });
});

describe('GST split (FR-3.2.1, UAT 4)', () => {
  it('Tamil Nadu client → CGST 9% + SGST 9%', () => {
    expect(splitTax(1_000_000_00, 18, '33')).toEqual({
      interState: false,
      cgst: 90_000_00,
      sgst: 90_000_00,
      igst: 0,
    });
  });

  it('Karnataka client → IGST 18%', () => {
    expect(splitTax(1_000_000_00, 18, '29')).toEqual({
      interState: true,
      cgst: 0,
      sgst: 0,
      igst: 180_000_00,
    });
  });

  it('rounds each half to the paisa', () => {
    expect(splitTax(10_050, 18, '33')).toMatchObject({ cgst: 905, sgst: 905 });
  });

  it('extracts tax from GST-inclusive advances at the document rate (A7)', () => {
    expect(taxInInclusive(118_000_00, 18)).toBe(18_000_00);
    expect(taxInInclusive(112_000_00, 12)).toBe(12_000_00);
    expect(taxInInclusive(50_000_00, 0)).toBe(0);
  });
});

describe('final review regressions (GST)', () => {
  it('BUG-197: the 40% slab is accepted and splits like any other rate', () => {
    expect(GST_RATES).toContain(40);
    expect(splitTax(100_000_00, 40, '33')).toMatchObject({ cgst: 20_000_00, sgst: 20_000_00 });
    expect(splitTax(100_000_00, 40, '29')).toMatchObject({ igst: 40_000_00 });
  });
});
