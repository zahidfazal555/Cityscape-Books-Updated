/** The nine cost categories (Req FR-11.3) and the project-cost account each posts to. */
export const COST_CATEGORIES = [
  'material',
  'labour',
  'subcontract',
  'transport',
  'fuel',
  'misc',
  'incentives',
  'site_visit',
  'rent',
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const CATEGORY_LABEL: Readonly<Record<CostCategory, string>> = {
  material: 'Material',
  labour: 'Labour',
  subcontract: 'Subcontract (FC)',
  transport: 'Transport',
  fuel: 'Fuel',
  misc: 'Miscellaneous',
  incentives: 'Incentives',
  site_visit: 'Site visit',
  rent: 'Rent/Equipment',
};

/** Chart of accounts 5000–5080 (migration 0001). */
export const CATEGORY_ACCOUNT: Readonly<Record<CostCategory, string>> = {
  material: '5000',
  labour: '5010',
  subcontract: '5020',
  transport: '5030',
  fuel: '5040',
  misc: '5050',
  incentives: '5060',
  site_visit: '5070',
  rent: '5080',
};

/** Where money paid out (or received) sits, by mode. Cheques clear through the bank account. */
export const PAYMENT_MODES = ['bank', 'upi', 'cash', 'cheque'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export const ACCOUNT_FOR_MODE: Readonly<Record<PaymentMode, '1000' | '1010' | '1020'>> = {
  cash: '1000',
  bank: '1010',
  cheque: '1010',
  upi: '1020',
};

/** Inventory (FR-18) material groups, from the purchase trackers. */
export const MATERIAL_CATEGORIES = [
  'Board',
  'Laminate',
  'Wood',
  'Hardware',
  'Paint',
  'Glass',
  'Stone',
  'Tiles',
  'Metal',
  'Cladding',
  'Electrical',
  'Plumbing',
  'Other',
] as const;
export type MaterialCategory = (typeof MATERIAL_CATEGORIES)[number];
