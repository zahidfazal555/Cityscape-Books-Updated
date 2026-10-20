# Changelog
All notable changes to this project are recorded here. Format: Keep a Changelog. Versioning: SemVer.

## [Unreleased]
### Added
- Passwords: the owner sets any other user's password from Users & access (same policy; the user is
  signed out everywhere, unlocked, and open invite/reset links stop working; audited as
  `password_set_by_owner`). Everyone can change their own password at /account/password, linked
  from the top bar (and the phone layout).
- Dashboard charts: KPI cards with colour accents; donuts for spend by category, spend by project
  and receivables by age (validated colour-blind-safe palette, legend with values, hover). Every
  slice opens its detail: a spend drill-down page per category (by project, every entry; wage
  payees hidden without the payroll right), the project, or Outstanding filtered by age bucket.
- Project page charts: the project's spend by category, budget and billing meters, and a six-month
  invoiced vs spent trend.
- Sign-in page: "CITYSCAPE BOOKS" wordmark; the logo keeps its proportions.
- Settings → Company (`PATCH /api/v1/settings`, owner-only): edit the name, legal name, GSTIN,
  state, address, phone, email and bank details printed on every document. The GSTIN must match
  the state; every change is audited with the bank account masked.
- PDF downloads (FR-3.4.5, Tech Spec §11), generated on the server with IBM Plex (OFL, bundled):
  tax invoices, credit notes, quotations, proformas, purchase orders, client receipts, purchase
  bills, payslips (whole run or one employee) and a client statement of account (FY to date). Every
  list and report export takes `?format=pdf` next to CSV. Drafts and cancelled documents carry a
  watermark on every page; every PDF download writes an audit row (H4).
- Final documents (invoice, credit note, quotation, proforma, PO, receipt, statement, approved
  payslip) carry the company mark as a very light watermark, on screen and in the PDF.
- Reports → Export for accountant (`GET /api/v1/reports/accountant-export?from&to`, owner and
  auditor, all projects): one ZIP of UTF-8 CSV files for the period: day book, trial balance,
  sales invoices, credit notes, receipts, purchase bills, vendor payments, expenses, payroll (with
  the payroll right) and the chart of accounts, plus a README. Audited (H4).
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

- The Owner's dashboard: alert banners (approvals waiting, projects at 85% or over 100% of the
  cost budget), KPI cards, active projects with income, expense, net value (with `pnl`) and budget
  used, spend by category and receivables ageing. Budget alerts also arrive as notifications when
  any cost is posted.

### Changed
- Document pages print from the same data as their PDF (`lib/documents.ts`); a cancelled invoice now
  shows a CANCELLED watermark. "Print / PDF" became "Download PDF" + "Print".
- Expenses CSV: the header listed "Paid to" twice, shifting Amount and Status one column right.
- H2 approvals are keyed to the Owner role: granting `approvals = full` to another user no longer
  lets their entries post directly or lets them approve.
- Uploaded photos are decoded with sharp off the event loop, and an image declaring more than 50 MP
  is refused from its header.
- Approving an expense or a quote discount names the version the Owner saw; an entry changed since
  is refused.
- The 40% GST slab (from 22 Sep 2025) is accepted on documents, purchase orders and bills.
- Production refuses `TRUSTED_PROXIES=0`; publish the app port on 127.0.0.1 behind the HTTPS proxy.

### Security
- Final whole-codebase review (BUG-183–197): change-password lockout race, IPv6 rate-limit keys,
  Postgres error details kept out of logs, root-owned image code, pinned third-party CI action,
  lock-date share lock, no DELETE for the app role on sessions/masters/accounts/allocations,
  company-scoped foreign keys, rate-change audit rows, proforma lock checks.
