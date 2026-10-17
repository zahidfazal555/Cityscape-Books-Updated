# Changelog
All notable changes to this project are recorded here. Format: Keep a Changelog. Versioning: SemVer.

## [Unreleased]
### Added
- Engineering standards, runbooks, contribution rules, PR template and security policy.
- Spec fixes v1.4 (accounting corrections A1–A8, schema fixes B1–B10, business rules C1–C2).
- Quotations with revisions and owner-approved discounts; proforma invoices with customer advances,
  conversion to tax invoices, and release of advances when a converted invoice is cancelled.
- Sales screens: quotations, proformas, tax invoices and client receipts, with printable A4 documents,
  live GST totals, CSV export of invoices and customer advances on the project page.
- Purchases: purchase orders, purchase bills with input-credit rules, and vendor payments with
  TDS; every non-owner payment waits for the Owner's approval.
- Expenses with required bill photos (type-sniffed, EXIF/GPS stripped, audited views), the Owner's
  approval queue (expenses, payments, discounts) and audited expense CSV export.
- Screens for purchase orders (with convert to bill), purchase bills and payments, expenses (filters,
  bill-photo viewer, audited CSV), the Owner's approval cards, and the site engineer's phone layout
  with camera capture.
- Accounts: cash/bank/UPI registers with opening balances and statement matching, spend by staff;
  receivables and payables with ageing; GST returns (GSTR-3B summary with set-off, GSTR-1 tables and
  JSON, Table 11A/11B, ITC register); reports (project income and expenses, P&L, category pivot,
  trial balance) with audited CSV exports.
- Accounts screens: account cards and registers with statement ticks and opening balances, spending by
  staff; outstanding tabs with the ageing bar; GST month view with 3B, GSTR-1, HSN, 11A/11B and the ITC
  register; report tabs with CSV.
- Payroll (FR-17): monthly staff with payroll runs and payslips (TDS, Tamil Nadu professional tax in
  September and March, advance recovery), staff advances, daily-wage workers with +1 attendance and
  wage payments to project labour, and contract jobs paid with TDS u/s 194C. H2: every run, advance,
  wage or contractor payment and every salary, daily-rate or job-value change by a non-owner waits for
  the Owner (Approvals → Payroll and Rate changes).
- Inventory (FR-18): material purchase tracking per project with category totals and audited CSV.
- Support (FR-19–21): service-desk tickets (TKT-####) with coverage decided at logging, SLA clocks and
  breach notifications, an activity thread (reply, call, internal note), site visits with required
  before/after photos whose cost becomes a Pending expense, customer ratings, linked quotations and
  invoices, and a support dashboard; the warranty register with handover (marks the project
  Completed); care guides and reply templates.
- Go-live: SMTP mail (MAIL_MODE=smtp), the header notification bell, scheduled jobs (`pnpm jobs`
  sla-sweep / verify-books / retention / bootstrap), the production Dockerfile with a CI image build, and
  docs/GO-LIVE.md.

### Changed
- H2 approvals are keyed to the Owner role: granting `approvals = full` to another user no longer
  lets their entries post directly or lets them approve.
