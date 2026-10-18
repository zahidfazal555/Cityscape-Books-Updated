import { describe, expect, it } from 'vitest';
import { formatDocNumber, seriesPeriod } from '../src/index.js';

describe('document numbers (Requirements §3.1)', () => {
  it('formats FY series', () => {
    expect(formatDocNumber('invoice', seriesPeriod('invoice', '2026-10-14'), 1)).toBe(
      'CSD/26-27/0001',
    );
    expect(formatDocNumber('creditNote', '26-27', 12)).toBe('CN/26-27/0012');
    expect(formatDocNumber('receipt', '26-27', 10_000)).toBe('RCT/26-27/10000');
  });

  it('formats non-FY series under a single period', () => {
    expect(seriesPeriod('project', '2027-05-01')).toBe('-');
    expect(formatDocNumber('project', '-', 7)).toBe('CSD-PRJ-0007');
    expect(formatDocNumber('ticket', '-', 42)).toBe('TKT-0042');
  });
});
