import type { BillStatus, ExpenseStatus, PaymentStatus, PoStatus } from '@csd/services';

type Tone = 'green' | 'amber' | 'red' | 'grey' | 'blue';

export const PO_STATUS: Record<PoStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'grey' },
  issued: { label: 'Issued', tone: 'blue' },
  partly_billed: { label: 'Partly billed', tone: 'amber' },
  billed: { label: 'Billed', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'grey' },
};

export const BILL_STATUS: Record<BillStatus, { label: string; tone: Tone }> = {
  unpaid: { label: 'Unpaid', tone: 'blue' },
  partially_paid: { label: 'Partially paid', tone: 'amber' },
  paid: { label: 'Paid', tone: 'green' },
  overdue: { label: 'Overdue', tone: 'red' },
};

export const APPROVAL_STATUS: Record<ExpenseStatus | PaymentStatus, { label: string; tone: Tone }> =
  {
    pending: { label: 'Pending', tone: 'amber' },
    approved: { label: 'Approved', tone: 'green' },
    rejected: { label: 'Rejected', tone: 'red' },
  };

/** Category colour dots (README §8). */
export const CATEGORY_DOT: Record<string, string> = {
  material: '#1f5fae',
  labour: '#8a5a00',
  subcontract: '#6b3fa0',
  transport: '#1e7a4c',
  fuel: '#b42318',
  misc: '#5b6573',
  incentives: '#c4730f',
  site_visit: '#0e7490',
  rent: '#7c5c3b',
};

/** FR-11.4: "Paid by" labels. */
export const PAID_BY = ['Saravanan', 'Shiva', 'Admin', 'Site Engineer'] as const;

export const EXPENSE_MODE_LABEL = { upi: 'UPI', cash: 'Cash', bank: 'Bank' } as const;

export const GST_CHIPS = ['0', '5', '12', '18', '28', '40'] as const;

/** Notice shown to everyone but the Owner (H2). */
export const OWNER_APPROVAL_NOTE =
  'This goes to the owner for approval. It is not counted in the books until approved.';
