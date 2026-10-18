import { describe, expect, it } from 'vitest';
import { CATEGORY_ACCOUNT, CATEGORY_LABEL, COST_CATEGORIES } from '../src/index.js';

describe('cost categories', () => {
  it('has the nine categories of FR-11.3, each with a label and a distinct project-cost account', () => {
    expect(COST_CATEGORIES).toHaveLength(9);
    expect(COST_CATEGORIES.map((c) => CATEGORY_LABEL[c])).toEqual([
      'Material',
      'Labour',
      'Subcontract (FC)',
      'Transport',
      'Fuel',
      'Miscellaneous',
      'Incentives',
      'Site visit',
      'Rent/Equipment',
    ]);
    const accounts = COST_CATEGORIES.map((c) => CATEGORY_ACCOUNT[c]);
    expect(new Set(accounts).size).toBe(9);
    expect(accounts.every((a) => /^50[0-8]0$/.test(a))).toBe(true);
  });
});
