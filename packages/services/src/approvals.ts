import { assertApprover, projectScope, type Actor } from '@csd/core';
import { withTenant } from '@csd/db';
import type pg from 'pg';
import { ExpensesService, type Expense } from './expenses.js';
import { LabourService, type LabourPayment } from './labour.js';
import {
  PayrollService,
  pendingAdvances,
  pendingRuns,
  type PayrollRun,
  type RateChange,
  type StaffAdvance,
} from './payroll.js';
import { tenantOf as ctx } from './validation.js';
import { QuotationsService, type QuoteSummary } from './quotations.js';
import { VendorPaymentsService, type VendorPayment } from './vendor-payments.js';

export interface ApprovalQueue {
  expenses: Expense[];
  payments: VendorPayment[];
  /** Draft quotations whose discount waits for the Owner. */
  discounts: QuoteSummary[];
  /** Payroll runs, staff advances, wage and contractor payments. */
  payroll: { runs: PayrollRun[]; advances: StaffAdvance[]; payments: LabourPayment[] };
  /** Salary, daily-rate and job-value changes. */
  rateChanges: RateChange[];
}

/** The Owner's approval screen (Req §4.12; H2 tabs: Expenses · Payments · Payroll · Rate changes · Discounts). */
export class ApprovalsService {
  private readonly expenses: ExpensesService;
  private readonly payments: VendorPaymentsService;
  private readonly quotes: QuotationsService;
  private readonly labour: LabourService;
  private readonly payrollService: PayrollService;

  constructor(private readonly pool: pg.Pool) {
    this.labour = new LabourService(pool);
    this.payrollService = new PayrollService(pool);
    this.expenses = new ExpensesService(pool);
    this.payments = new VendorPaymentsService(pool);
    this.quotes = new QuotationsService(pool);
  }

  async queue(actor: Actor): Promise<ApprovalQueue> {
    assertApprover(actor);
    const expenses = await this.expenses.pending(actor);
    const payments = await this.payments.pending(actor);
    return {
      expenses,
      payments,
      discounts: await this.quotes.pendingDiscounts(actor),
      payroll: {
        ...(await this.companyWide(actor)),
        payments: await this.labour.pendingPayments(actor),
      },
      rateChanges: await this.payrollService.pendingRates(actor),
    };
  }

  /** Runs and staff advances are company-wide: shown only to an approver with all projects. */
  private async companyWide(actor: Actor) {
    if (projectScope(actor) !== null) return { runs: [], advances: [] };
    return withTenant(this.pool, ctx(actor), async (c) => ({
      runs: await pendingRuns(c),
      advances: await pendingAdvances(c),
    }));
  }

  /** Number waiting, for the side-nav badge. */
  async count(actor: Actor): Promise<number> {
    const q = await this.queue(actor);
    const pr = q.payroll;
    return (
      q.expenses.length +
      q.payments.length +
      q.discounts.length +
      pr.runs.length +
      pr.advances.length +
      pr.payments.length +
      q.rateChanges.length
    );
  }
}
