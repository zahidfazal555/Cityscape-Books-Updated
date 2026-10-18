import { describe, expect, it } from 'vitest';
import { contractTds, isPtMonth, payslipFor, wagesFor } from '../src/index.js';

const base = {
  gross: 48_000_00,
  monthlyTds: 0,
  ptHalfYear: 1_250_00,
  recoveryInstalment: 2_000_00,
  advanceOutstanding: 5_000_00,
};

describe('payroll rules (FR-17, SPEC-FIXES C2)', () => {
  it('deducts professional tax only in September and March', () => {
    expect(['2026-09', '2027-03', '2026-10'].map(isPtMonth)).toEqual([true, true, false]);
    expect(() => isPtMonth('2026-13')).toThrow();
    expect(payslipFor('2026-10', base)).toEqual({
      gross: 48_000_00,
      tds: 0,
      pt: 0,
      recovery: 2_000_00,
      net: 46_000_00,
    });
    expect(payslipFor('2026-09', base).pt).toBe(1_250_00);
  });

  it('never recovers more than is owed, and never takes the net below zero', () => {
    expect(payslipFor('2026-10', { ...base, advanceOutstanding: 500_00 }).recovery).toBe(500_00);
    const tiny = payslipFor('2026-09', {
      gross: 1_000_00,
      monthlyTds: 800_00,
      ptHalfYear: 1_250_00,
      recoveryInstalment: 2_000_00,
      advanceOutstanding: 5_000_00,
    });
    expect(tiny).toEqual({ gross: 1_000_00, tds: 800_00, pt: 200_00, recovery: 0, net: 0 });
  });

  it('pays wages by half days and works out 194C TDS', () => {
    expect(wagesFor(900_00, 15)).toBe(1_350_00);
    expect(wagesFor(333_33, 5)).toBe(166_67);
    expect(() => wagesFor(900_00, -1)).toThrow();
    expect(contractTds(50_000_00, 1)).toBe(500_00);
    expect(contractTds(50_000_00, 2)).toBe(1_000_00);
  });
});
