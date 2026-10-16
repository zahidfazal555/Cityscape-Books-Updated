import { DomainError } from './errors.js';
import { GST_RATES, splitTax } from './gst.js';
import { assertPaise, mulDivHalfUp, roundToRupee, toBasisPoints, type Paise } from './money.js';

/** Quantities are integer thousandths (NUMERIC(12,3)): 1.5 sq ft = 1500. */
export type QtyMilli = number;

export interface LineInput {
  description: string;
  sacHsn: string;
  qtyMilli: QtyMilli;
  unit: string;
  rate: Paise;
  gstRate: number;
}

export interface LineTotals {
  amount: Paise;
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
}

export interface DocumentTotals {
  lines: LineTotals[];
  subtotal: Paise;
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  /** Taxable + tax before rounding. */
  gross: Paise;
  roundOff: Paise;
  /** Rounded to the rupee (SPEC-FIXES A6). */
  total: Paise;
  interState: boolean;
}

const MAX_QTY_MILLI = 999_999_999_999; // NUMERIC(12,3)

export function parseQty(input: string, field = 'qty'): QtyMilli {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(input.trim().replace(/,/g, ''));
  if (!m) throw new DomainError('VALIDATION', 'Enter a valid quantity (up to 3 decimals).', field);
  const milli = Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0'));
  if (milli <= 0 || milli > MAX_QTY_MILLI)
    throw new DomainError('VALIDATION', 'Quantity must be more than zero.', field);
  return milli;
}

export function formatQty(milli: QtyMilli): string {
  const whole = Math.trunc(milli / 1000);
  const frac = String(milli % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

function assertLine(l: LineInput, i: number): void {
  if (!l.description.trim())
    throw new DomainError('VALIDATION', 'Describe every line.', `lines.${i}.description`);
  if (!Number.isSafeInteger(l.qtyMilli) || l.qtyMilli <= 0) {
    throw new DomainError('VALIDATION', 'Quantity must be more than zero.', `lines.${i}.qty`);
  }
  if (l.qtyMilli > MAX_QTY_MILLI)
    throw new DomainError('VALIDATION', 'Quantity is too large.', `lines.${i}.qty`);
  assertPaise(l.rate, `lines.${i}.rate`);
  if (l.rate < 0)
    throw new DomainError('VALIDATION', 'Rate cannot be negative.', `lines.${i}.rate`);
  if (!(GST_RATES as readonly number[]).includes(l.gstRate)) {
    throw new DomainError(
      'VALIDATION',
      'GST rate must be 0, 5, 12, 18 or 28%.',
      `lines.${i}.gstRate`,
    );
  }
  if (!/^\d{4,8}$/.test(l.sacHsn))
    throw new DomainError('VALIDATION', 'SAC/HSN must be 4–8 digits.', `lines.${i}.sacHsn`);
}

/**
 * Totals for a quotation, proforma, tax invoice or credit note. Every amount is computed per
 * line to the paisa (qty × rate, less the document discount, then GST split by place of
 * supply); the grand total is rounded to the rupee with a round-off (SPEC-FIXES A6).
 */
export function computeDocument(
  lines: readonly LineInput[],
  opts: { discountPct?: number; placeOfSupply: string; companyStateCode?: string },
): DocumentTotals {
  if (lines.length === 0) throw new DomainError('VALIDATION', 'Add at least one line.', 'lines');
  if (lines.length > 200)
    throw new DomainError('VALIDATION', 'A document can have at most 200 lines.', 'lines');
  let discountBp: number;
  try {
    discountBp = toBasisPoints(opts.discountPct ?? 0);
  } catch {
    throw new DomainError('VALIDATION', 'Discount may have at most 2 decimals.', 'discountPct');
  }
  if (discountBp < 0 || discountBp > 5000) {
    throw new DomainError('VALIDATION', 'Discount must be between 0 and 50%.', 'discountPct');
  }
  const totals = lines.map((l, i): LineTotals & { interState: boolean } => {
    assertLine(l, i);
    const amount = mulDivHalfUp(l.rate, l.qtyMilli, 1000);
    const discount = mulDivHalfUp(amount, discountBp, 10_000);
    const taxable = amount - discount;
    const tax = splitTax(taxable, l.gstRate, opts.placeOfSupply, opts.companyStateCode);
    return {
      amount,
      discount,
      taxable,
      cgst: tax.cgst,
      sgst: tax.sgst,
      igst: tax.igst,
      interState: tax.interState,
    };
  });
  const sum = (k: keyof LineTotals): Paise => totals.reduce((s, t) => s + t[k], 0);
  const taxable = sum('taxable');
  const gross = taxable + sum('cgst') + sum('sgst') + sum('igst');
  const { total, roundOff } = roundToRupee(gross);
  return {
    lines: totals.map(({ interState: _i, ...t }) => t),
    subtotal: sum('amount'),
    discount: sum('discount'),
    taxable,
    cgst: sum('cgst'),
    sgst: sum('sgst'),
    igst: sum('igst'),
    gross,
    roundOff,
    total: assertPaise(total),
    interState: totals[0]?.interState ?? false,
  };
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = TENS[Math.floor(n / 10)] ?? '';
  return n % 10 ? `${t} ${ONES[n % 10]}` : t;
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

/** Integer rupees in words, Indian system (FR-3.2.5): Crore, Lakh, Thousand. */
function rupeeWords(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1e3);
  const rest = n % 1e3;
  return [
    crore ? `${crore >= 100 ? rupeeWords(crore) : belowHundred(crore)} Crore` : '',
    lakh ? `${belowHundred(lakh)} Lakh` : '',
    thousand ? `${belowHundred(thousand)} Thousand` : '',
    rest ? belowThousand(rest) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** ₹11,80,000.50 → "Rupees Eleven Lakh Eighty Thousand and Fifty Paise Only". */
export function amountInWords(paise: Paise): string {
  assertPaise(paise);
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const sign = paise < 0 ? 'Minus ' : '';
  return `${sign}Rupees ${rupeeWords(rupees)}${p ? ` and ${belowHundred(p)} Paise` : ''} Only`;
}

export type InvoiceStatus = 'unpaid' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled';

/** Derived, never stored (README §5): cancelled, paid, partially paid, overdue or unpaid. */
export function invoiceStatus(
  inv: { cancelled: boolean; total: Paise; balance: Paise; dueDate: string },
  today: string,
): InvoiceStatus {
  if (inv.cancelled) return 'cancelled';
  if (inv.balance <= 0) return 'paid';
  if (inv.dueDate < today) return 'overdue';
  return inv.balance < inv.total ? 'partially_paid' : 'unpaid';
}
