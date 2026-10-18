import { describe, expect, it } from 'vitest';
import {
  DomainError,
  mulDivHalfUp,
  percentOf,
  roleTemplate,
  stripPnl,
  taxInInclusive,
  toBasisPoints,
  type Actor,
} from '../src/index.js';

const pm: Actor = {
  userId: 'u',
  companyId: 'c',
  role: 'manager',
  rights: roleTemplate('manager'),
  projects: 'all',
  active: true,
};

describe('review regressions (core)', () => {
  it('BUG-004: stripPnl keeps Dates and class instances intact', () => {
    const when = new Date('2026-10-16T05:00:00Z');
    const out = stripPnl(pm, { createdAt: when, profit: 1, rows: [{ at: when, margin: 2 }] });
    expect(out).toEqual({ createdAt: when, rows: [{ at: when }] });
    expect(JSON.stringify(out)).toContain('2026-10-16T05:00:00.000Z');
  });

  it('BUG-010: inclusive-tax rounding is symmetric for negative amounts', () => {
    for (const amount of [1_050, 10_525, 118_000_00, 7]) {
      for (const rate of [5, 18]) {
        expect(taxInInclusive(-amount, rate) + taxInInclusive(amount, rate)).toBe(0);
      }
    }
    expect(Object.is(taxInInclusive(-7, 5), 0)).toBe(true); // never -0
  });

  it('BUG-010: percentages stay exact at the NUMERIC(14,2) limit', () => {
    const max = 99_999_999_999_999;
    const exact = (BigInt(max) * 2800n * 2n + 10_000n) / 20_000n;
    expect(percentOf(max, 28)).toBe(Number(exact));
    expect(percentOf(-max, 28)).toBe(-Number(exact));
  });

  it('rejects percentages with more than 2 decimals and bad divisors', () => {
    expect(toBasisPoints(2.5)).toBe(250);
    expect(() => toBasisPoints(9.555)).toThrow(RangeError);
    expect(() => mulDivHalfUp(100, 1, 0)).toThrow(RangeError);
    expect(() => mulDivHalfUp(100, 1.5, 2)).toThrow(RangeError);
  });

  it('DomainError serialises to the API error shape', () => {
    expect(new DomainError('VALIDATION', 'Bad', 'amount').toJSON()).toEqual({
      code: 'VALIDATION',
      message: 'Bad',
      field: 'amount',
    });
    expect(JSON.parse(JSON.stringify(new DomainError('FORBIDDEN', 'No')))).toEqual({
      code: 'FORBIDDEN',
      message: 'No',
    });
  });
});

describe('second review regressions (core)', () => {
  class ProjectSummary {
    constructor(
      readonly name: string,
      readonly profit: number,
      readonly margin: number,
    ) {}
  }

  it('BUG-011: profit inside class instances is still stripped', () => {
    expect(stripPnl(pm, { p: new ProjectSummary('A', 5, 0.2) })).toEqual({ p: { name: 'A' } });
  });

  it('BUG-012: a "__proto__" key is copied as data, never used as a prototype', () => {
    const input = JSON.parse('{"__proto__": {"x": 1}, "a": 2}') as Record<string, unknown>;
    const out = stripPnl(pm, input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"x":1},"a":2}');
  });
});
