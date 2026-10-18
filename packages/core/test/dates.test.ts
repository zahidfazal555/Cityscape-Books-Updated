import { describe, expect, it } from 'vitest';
import {
  assertNotLocked,
  financialYear,
  financialYearStart,
  formatDate,
  parseIsoDate,
} from '../src/index.js';

describe('dates and financial year', () => {
  it('formats as DD MMM YYYY', () => {
    expect(formatDate('2026-10-14')).toBe('14 Oct 2026');
  });

  it('rejects impossible dates', () => {
    expect(() => parseIsoDate('2026-02-30')).toThrow('Enter a valid date.');
    expect(() => parseIsoDate('14/10/2026')).toThrow();
  });

  it('labels the April–March FY', () => {
    expect(financialYear('2026-04-01')).toBe('26-27');
    expect(financialYear('2027-03-31')).toBe('26-27');
    expect(financialYear('2026-03-31')).toBe('25-26');
    expect(financialYearStart('2026-10-14')).toBe('2026-04-01');
    expect(financialYearStart('2027-03-31')).toBe('2026-04-01');
    expect(financialYearStart('2026-10-14', 1)).toBe('2026-01-01');
    expect(financialYear('2099-12-01')).toBe('99-00');
    expect(financialYear('2026-06-01', 1)).toBe('26');
  });
});

describe('lock date (FR-3.3.1, UAT 6)', () => {
  it('refuses the lock date itself and anything earlier', () => {
    expect(() => assertNotLocked('2026-09-30', '2026-09-30')).toThrow(
      'Books are locked till 30 Sep 2026. Pick a later date.',
    );
    expect(() => assertNotLocked('2026-04-01', '2026-09-30')).toThrow();
  });

  it('allows later dates and books with no lock', () => {
    expect(() => assertNotLocked('2026-10-01', '2026-09-30')).not.toThrow();
    expect(() => assertNotLocked('2020-01-01', null)).not.toThrow();
  });

  it('returns HTTP 423 with the field name', () => {
    try {
      assertNotLocked('2026-09-01', '2026-09-30', 'invoiceDate');
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ status: 423, code: 'PERIOD_LOCKED', field: 'invoiceDate' });
    }
  });
});

describe('business date in India', () => {
  it('uses IST, not UTC, around midnight', async () => {
    const { todayIn } = await import('../src/index.js');
    // 01:30 IST on 31 Oct = 20:00 UTC on 30 Oct
    expect(todayIn('Asia/Kolkata', new Date('2026-10-30T20:00:00Z'))).toBe('2026-10-31');
    expect(todayIn('UTC', new Date('2026-10-30T20:00:00Z'))).toBe('2026-10-30');
  });
});
