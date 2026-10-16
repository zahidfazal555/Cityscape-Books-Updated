import { describe, expect, it } from 'vitest';
import {
  assertPaise,
  formatInr,
  formatInrShort,
  fromDecimalString,
  parseRupees,
  percentOf,
  roundHalfUp,
  roundToRupee,
  toDecimalString,
} from '../src/index.js';

describe('money', () => {
  it('parses Indian-grouped rupees into paise', () => {
    expect(parseRupees('1,23,456.7')).toBe(12_345_670);
    expect(parseRupees('₹ 500')).toBe(50_000);
    expect(parseRupees('-0.05')).toBe(-5);
  });

  it('rejects junk and more than 2 decimals', () => {
    expect(() => parseRupees('12.345')).toThrow('Enter a valid amount.');
    expect(() => parseRupees('abc')).toThrow();
    expect(() => parseRupees('')).toThrow();
  });

  it('round-trips NUMERIC strings', () => {
    expect(toDecimalString(12_345_670)).toBe('123456.70');
    expect(toDecimalString(-5)).toBe('-0.05');
    expect(fromDecimalString('100.00')).toBe(10_000);
  });

  it('refuses unsafe or out-of-range values', () => {
    expect(() => assertPaise(0.5)).toThrow();
    expect(() => assertPaise(1e15)).toThrow();
  });

  it('rounds half away from zero', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(2.4)).toBe(2);
  });

  it('computes percentages to the paisa, half-up', () => {
    expect(percentOf(10_001, 9)).toBe(900); // 900.09 → 900
    expect(percentOf(10_050, 9)).toBe(905); // 904.5 → 905
    expect(percentOf(100_000_00, 18)).toBe(18_000_00);
  });

  it('rounds document totals to the rupee with a round-off line', () => {
    expect(roundToRupee(1_180_049)).toEqual({ total: 1_180_000, roundOff: -49 });
    expect(roundToRupee(1_180_050)).toEqual({ total: 1_180_100, roundOff: 50 });
  });

  it('formats en-IN currency', () => {
    expect(formatInr(10_000_000)).toBe('₹1,00,000.00');
    expect(formatInrShort(45_000_000)).toBe('₹4.50 L');
    expect(formatInrShort(1_200_000_000)).toBe('₹1.20 Cr');
    expect(formatInrShort(99_900)).toBe('₹999');
  });
});
