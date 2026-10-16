import { assertApprover, type Actor } from '@csd/core';
import type pg from 'pg';
import { ExpensesService, type Expense } from './expenses.js';
import { QuotationsService, type QuoteSummary } from './quotations.js';
import { VendorPaymentsService, type VendorPayment } from './vendor-payments.js';

export interface ApprovalQueue {
  expenses: Expense[];
  payments: VendorPayment[];
  /** Draft quotations whose discount waits for the Owner. */
  discounts: QuoteSummary[];
}

/** The Owner's approval screen (Req §4.12, H2 tabs: Expenses · Payments · Discounts). */
export class ApprovalsService {
  private readonly expenses: ExpensesService;
  private readonly payments: VendorPaymentsService;
  private readonly quotes: QuotationsService;

  constructor(pool: pg.Pool) {
    this.expenses = new ExpensesService(pool);
    this.payments = new VendorPaymentsService(pool);
    this.quotes = new QuotationsService(pool);
  }

  async queue(actor: Actor): Promise<ApprovalQueue> {
    assertApprover(actor);
    const expenses = await this.expenses.pending(actor);
    const payments = await this.payments.pending(actor);
    const drafts = await this.quotes.list(actor, { status: 'draft' });
    return {
      expenses,
      payments,
      discounts: drafts.filter((q) => q.discountPct > 0 && !q.discountApproved),
    };
  }

  /** Number waiting, for the side-nav badge. */
  async count(actor: Actor): Promise<number> {
    const q = await this.queue(actor);
    return q.expenses.length + q.payments.length + q.discounts.length;
  }
}
