import { describe, expect, it } from 'vitest';
import {
  amountInWords,
  computeDocument,
  formatQty,
  parseQty,
  type LineInput,
} from '../src/index.js';

const line = (over: Partial<LineInput> = {}): LineInput => ({
  description: 'False ceiling – gypsum',
  sacHsn: '9954',
  qtyMilli: 1000,
  unit: 'nos',
  rate: 10_00_000_00,
  gstRate: 18,
  ...over,
});

describe('quantities', () => {
  it('parses and formats up to 3 decimals', () => {
    expect(parseQty('1,250.5')).toBe(1_250_500);
    expect(formatQty(1_250_500)).toBe('1250.5');
    expect(formatQty(3000)).toBe('3');
    expect(() => parseQty('0')).toThrow('more than zero');
    expect(() => parseQty('1.2345')).toThrow('3 decimals');
  });
});

describe('document totals', () => {
  it('UAT 4: Tamil Nadu client → CGST 9% + SGST 9%; Karnataka → IGST 18%', () => {
    const tn = computeDocument([line()], { placeOfSupply: '33' });
    expect(tn).toMatchObject({
      taxable: 10_00_000_00,
      cgst: 90_000_00,
      sgst: 90_000_00,
      igst: 0,
      total: 11_80_000_00,
      roundOff: 0,
      interState: false,
    });
    const ka = computeDocument([line()], { placeOfSupply: '29' });
    expect(ka).toMatchObject({
      cgst: 0,
      sgst: 0,
      igst: 1_80_000_00,
      total: 11_80_000_00,
      interState: true,
    });
  });

  it('computes qty × rate per line, applies the discount per line, then rounds the total', () => {
    const t = computeDocument(
      [
        line({ qtyMilli: 1_250_500, rate: 85_50 }),
        line({ qtyMilli: 3000, rate: 1_999_99, gstRate: 12 }),
      ],
      { placeOfSupply: '33', discountPct: 7.5 },
    );
    // 1250.5 × ₹85.50 = ₹1,06,917.75; 7.5% = ₹8,018.83 → ₹98,898.92
    expect(t.lines[0]).toMatchObject({
      amount: 1_06_917_75,
      discount: 8_018_83,
      taxable: 98_898_92,
    });
    expect(t.lines[1]).toMatchObject({ amount: 5_999_97, discount: 450_00, taxable: 5_549_97 });
    expect(t.subtotal - t.discount).toBe(t.taxable);
    expect(t.gross).toBe(t.taxable + t.cgst + t.sgst + t.igst);
    expect(t.total % 100).toBe(0);
    expect(t.total - t.gross).toBe(t.roundOff);
    expect(Math.abs(t.roundOff)).toBeLessThanOrEqual(50);
  });

  it('validates lines and the 0–50% discount', () => {
    expect(() => computeDocument([], { placeOfSupply: '33' })).toThrow('at least one line');
    expect(() => computeDocument([line({ gstRate: 15 })], { placeOfSupply: '33' })).toThrow(
      expect.objectContaining({ field: 'lines.0.gstRate' }),
    );
    expect(() => computeDocument([line({ description: ' ' })], { placeOfSupply: '33' })).toThrow(
      expect.objectContaining({ field: 'lines.0.description' }),
    );
    expect(() => computeDocument([line({ sacHsn: '99' })], { placeOfSupply: '33' })).toThrow(
      expect.objectContaining({ field: 'lines.0.sacHsn' }),
    );
    expect(() => computeDocument([line({ rate: -1 })], { placeOfSupply: '33' })).toThrow(
      expect.objectContaining({ field: 'lines.0.rate' }),
    );
    expect(() => computeDocument([line({ qtyMilli: 0 })], { placeOfSupply: '33' })).toThrow(
      expect.objectContaining({ field: 'lines.0.qty' }),
    );
    expect(() => computeDocument([line()], { placeOfSupply: '33', discountPct: 51 })).toThrow(
      expect.objectContaining({ field: 'discountPct' }),
    );
    // BUG-076: bad precision or NaN is a 422 on the field, not a 500.
    for (const bad of [7.555, Number.NaN]) {
      expect(() => computeDocument([line()], { placeOfSupply: '33', discountPct: bad })).toThrow(
        expect.objectContaining({ status: 422, field: 'discountPct' }),
      );
    }
    expect(() => computeDocument([line({ qtyMilli: 1e13 })], { placeOfSupply: '33' })).toThrow(
      'too large',
    );
    expect(() =>
      computeDocument(
        Array.from({ length: 201 }, () => line()),
        { placeOfSupply: '33' },
      ),
    ).toThrow('200 lines');
  });
});

describe('amount in words (FR-3.2.5, Indian system)', () => {
  it.each([
    [11_80_000_00, 'Rupees Eleven Lakh Eighty Thousand Only'],
    [
      1_23_45_678_50,
      'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only',
    ],
    [0, 'Rupees Zero Only'],
    [1_05, 'Rupees One and Five Paise Only'],
    [250_00_00_000_00, 'Rupees Two Hundred Fifty Crore Only'],
    [-10_000_00, 'Minus Rupees Ten Thousand Only'],
  ])('%i paise', (p, words) => expect(amountInWords(p)).toBe(words));
});

describe('invoice status (derived)', () => {
  const base = { cancelled: false, total: 100_00, balance: 100_00, dueDate: '2026-10-31' };
  it.each([
    [{ ...base, cancelled: true }, 'cancelled'],
    [{ ...base, balance: 0 }, 'paid'],
    [{ ...base, dueDate: '2026-10-01' }, 'overdue'],
    [{ ...base, balance: 40_00, dueDate: '2026-10-01' }, 'overdue'],
    [{ ...base, balance: 40_00 }, 'partially_paid'],
    [base, 'unpaid'],
  ] as const)('%o → %s', async (inv, status) => {
    const { invoiceStatus } = await import('../src/index.js');
    expect(invoiceStatus(inv, '2026-10-16')).toBe(status);
  });
});
