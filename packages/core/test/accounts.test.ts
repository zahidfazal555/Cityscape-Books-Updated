import { describe, expect, it } from 'vitest';
import {
  advanceTax,
  ageingBucket,
  buildGstr1,
  daysBetween,
  daysOverdue,
  gstr1DueDate,
  monthRange,
  overdueTone,
  returnDueDate,
  setOff,
} from '../src/index.js';

describe('dates for returns', () => {
  it('counts days and month ranges, including leap February', () => {
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
    expect(daysBetween('2026-10-31', '2026-10-01')).toBe(-30);
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(() => monthRange('2026-13')).toThrow();
  });

  it('GSTR-3B is due on the 20th and GSTR-1 on the 11th of the next month, across the year end', () => {
    expect(returnDueDate('2026-10')).toBe('2026-11-20');
    expect(returnDueDate('2026-12')).toBe('2027-01-20');
    expect(gstr1DueDate('2026-10')).toBe('2026-11-11');
  });
});

describe('ageing (FR-14.1)', () => {
  it('buckets by days past due and colours amber > 0, red > 60', () => {
    expect(daysOverdue('2026-10-20', '2026-10-16')).toBe(0);
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(ageingBucket)).toEqual([
      'current',
      'd1_30',
      'd1_30',
      'd31_60',
      'd31_60',
      'd61_90',
      'd61_90',
      'd90_plus',
    ]);
    expect([0, 5, 61].map(overdueTone)).toEqual(['none', 'amber', 'red']);
  });
});

describe('tax on advances (Table 11A, SPEC-FIXES A7)', () => {
  it('takes the tax out of a GST-inclusive advance at the document rate', () => {
    // ₹1,18,000 at 18%: ₹18,000 tax, split CGST/SGST in Tamil Nadu.
    expect(advanceTax(1_18_000_00, [{ rate: 18, value: 1 }], false)).toEqual({
      taxable: 1_00_000_00,
      tax: { igst: 0, cgst: 9_000_00, sgst: 9_000_00 },
    });
    expect(advanceTax(1_12_000_00, [{ rate: 12, value: 1 }], true).tax.igst).toBe(12_000_00);
  });

  it('splits a mixed-rate proforma pro rata and the parts add up exactly', () => {
    const t = advanceTax(
      1_00_001,
      [
        { rate: 18, value: 2 },
        { rate: 12, value: 1 },
      ],
      false,
    );
    expect(t.taxable + t.tax.cgst + t.tax.sgst).toBe(1_00_001);
    expect(Math.abs(t.tax.cgst - t.tax.sgst)).toBeLessThanOrEqual(1);
  });
});

describe('ITC set-off order (Rule 88A)', () => {
  it('uses IGST credit first (IGST, then CGST, then SGST)', () => {
    const s = setOff({ igst: 100, cgst: 50, sgst: 50 }, { igst: 180, cgst: 0, sgst: 0 });
    expect(s.cash).toEqual({ igst: 0, cgst: 0, sgst: 20 });
    expect(s.carryForward).toEqual({ igst: 0, cgst: 0, sgst: 0 });
  });

  it('never uses CGST credit for SGST (or the reverse); leftovers carry forward', () => {
    const s = setOff({ igst: 0, cgst: 10, sgst: 100 }, { igst: 0, cgst: 80, sgst: 0 });
    expect(s.cash).toEqual({ igst: 0, cgst: 0, sgst: 100 });
    expect(s.carryForward).toEqual({ igst: 0, cgst: 70, sgst: 0 });
  });

  it('lets CGST and SGST credit pay IGST after their own head', () => {
    const s = setOff({ igst: 100, cgst: 10, sgst: 10 }, { igst: 0, cgst: 60, sgst: 60 });
    expect(s.cash).toEqual({ igst: 0, cgst: 0, sgst: 0 });
    // ₹120 of credit fully covers ₹120 of liability: nothing carries forward.
    expect(s.carryForward).toEqual({ igst: 0, cgst: 0, sgst: 0 });
  });
});

describe('GSTR-1 JSON (FR-15.6)', () => {
  it('builds b2b by GSTIN, b2cs by place and rate, cdnr and hsn in GSTN units', () => {
    const tax = { igst: 0, cgst: 9_000_00, sgst: 9_000_00 };
    const j = buildGstr1({
      gstin: '33AAACC1234D1Z5',
      period: '2026-10',
      invoices: [
        {
          number: 'CSD/26-27/0001',
          date: '2026-10-05',
          ctin: '33AAKFV7731M1Z1',
          pos: '33',
          interState: false,
          total: 1_18_000_00,
          items: [{ rate: 18, taxable: 1_00_000_00, tax }],
        },
        {
          number: 'CSD/26-27/0002',
          date: '2026-10-06',
          ctin: null,
          pos: '33',
          interState: false,
          total: 1_18_000_00,
          items: [{ rate: 18, taxable: 1_00_000_00, tax }],
        },
      ],
      creditNotes: [
        {
          number: 'CN/26-27/0001',
          date: '2026-10-09',
          ctin: '33AAKFV7731M1Z1',
          pos: '33',
          interState: false,
          total: 1_18_000_00,
          items: [{ rate: 18, taxable: 1_00_000_00, tax }],
        },
      ],
      hsn: [
        {
          b2b: true,
          hsn: '9954',
          rate: 18,
          qtyMilli: 2000,
          taxable: 2_00_000_00,
          tax: { igst: 0, cgst: 18_000_00, sgst: 18_000_00 },
        },
      ],
    });
    expect(j.fp).toBe('102026');
    expect(j.b2b).toEqual([
      {
        ctin: '33AAKFV7731M1Z1',
        inv: [
          expect.objectContaining({
            inum: 'CSD/26-27/0001',
            idt: '05-10-2026',
            val: 118000,
            itms: [
              {
                num: 1,
                itm_det: { rt: 18, txval: 100000, iamt: 0, camt: 9000, samt: 9000, csamt: 0 },
              },
            ],
          }),
        ],
      },
    ]);
    expect(j.b2cs).toEqual([
      {
        sply_ty: 'INTRA',
        pos: '33',
        typ: 'OE',
        rt: 18,
        txval: 100000,
        iamt: 0,
        camt: 9000,
        samt: 9000,
        csamt: 0,
      },
    ]);
    expect(j.cdnr[0]?.nt[0]).toMatchObject({
      ntty: 'C',
      nt_num: 'CN/26-27/0001',
      nt_dt: '09-10-2026',
    });
    expect(j.hsn.hsn_b2b[0]).toMatchObject({
      hsn_sc: '9954',
      uqc: 'NA',
      qty: 0,
      txval: 200000,
      camt: 18000,
    });
    expect(j.hsn.hsn_b2c).toEqual([]);
  });
});

describe('review regressions (PR 12, core)', () => {
  it('BUG-122: IGST credit goes where the own-head credit falls short, leaving least cash to pay', () => {
    const s = setOff({ igst: 0, cgst: 100, sgst: 100 }, { igst: 100, cgst: 100, sgst: 0 });
    expect(s.cash).toEqual({ igst: 0, cgst: 0, sgst: 0 });
    expect(s.carryForward).toEqual({ igst: 0, cgst: 0, sgst: 0 });
  });

  it('BUG-121/123: large inter-state B2C invoices go to b2cl, their notes to cdnur; small B2C notes net into b2cs', () => {
    const igst = (n: number) => ({ igst: n, cgst: 0, sgst: 0 });
    const big = {
      number: 'CSD/26-27/0009',
      date: '2026-10-02',
      ctin: null,
      pos: '29',
      interState: true,
      total: 3_54_000_00,
      items: [{ rate: 18, taxable: 3_00_000_00, tax: igst(54_000_00) }],
    };
    const small = {
      ...big,
      number: 'CSD/26-27/0010',
      total: 11_800_00,
      items: [{ rate: 18, taxable: 10_000_00, tax: igst(1_800_00) }],
    };
    const j = buildGstr1({
      gstin: '33AAACC1234D1Z5',
      period: '2026-10',
      invoices: [big, small],
      creditNotes: [
        { ...big, number: 'CN/26-27/0001' },
        { ...small, number: 'CN/26-27/0002' },
      ],
      hsn: [],
    });
    expect(j.b2cl).toEqual([
      { pos: '29', inv: [expect.objectContaining({ inum: 'CSD/26-27/0009', val: 354000 })] },
    ]);
    expect(j.cdnur).toEqual([expect.objectContaining({ typ: 'B2CL', nt_num: 'CN/26-27/0001' })]);
    // The small invoice and its credit note cancel out in b2cs.
    expect(j.b2cs).toEqual([]);
  });
});
