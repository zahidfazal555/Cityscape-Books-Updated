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

### Changed
- H2 approvals are keyed to the Owner role: granting `approvals = full` to another user no longer
  lets their entries post directly or lets them approve.
