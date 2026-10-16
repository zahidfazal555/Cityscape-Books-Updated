import type { InvoiceStatus } from '@csd/core';
import type { ProformaStatus, QuoteStatus, ReceiptMode } from '@csd/services';

type Tone = 'green' | 'amber' | 'red' | 'grey' | 'blue';

export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; tone: Tone }> = {
  unpaid: { label: 'Unpaid', tone: 'blue' },
  partially_paid: { label: 'Partially paid', tone: 'amber' },
  paid: { label: 'Paid', tone: 'green' },
  overdue: { label: 'Overdue', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'grey' },
};

export const QUOTE_STATUS: Record<QuoteStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'grey' },
  sent: { label: 'Sent', tone: 'blue' },
  accepted: { label: 'Accepted', tone: 'green' },
  declined: { label: 'Declined', tone: 'red' },
  expired: { label: 'Expired', tone: 'amber' },
};

export const PROFORMA_STATUS: Record<ProformaStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'grey' },
  sent: { label: 'Sent', tone: 'blue' },
  partially_paid: { label: 'Partially paid', tone: 'amber' },
  paid: { label: 'Paid', tone: 'green' },
  overdue: { label: 'Overdue', tone: 'red' },
  converted: { label: 'Converted', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'grey' },
};

/** Same order as the service's RECEIPT_MODES; kept here so client code never imports services. */
export const RECEIPT_MODES: readonly ReceiptMode[] = ['bank', 'upi', 'cash', 'cheque'];

export const MODE_LABEL: Record<ReceiptMode, string> = {
  bank: 'Bank transfer',
  upi: 'UPI',
  cash: 'Cash',
  cheque: 'Cheque',
};

/** The reference field's label follows the mode (README §6). */
export const REFERENCE_LABEL: Record<ReceiptMode, string> = {
  bank: 'UTR / transaction reference',
  upi: 'UPI reference',
  cash: 'Reference (optional)',
  cheque: 'Cheque number',
};

/** Rows of a list as CSV text (RFC 4180 quoting), for the "Export CSV" buttons. */
export function toCsv(rows: readonly (readonly (string | number)[])[]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    // A leading = + - @ would run as a formula in a spreadsheet.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
