# Cityscape Books — Spec fixes (v1.4)

This document overrides the handoff pack (`docs/handoff/`) wherever they conflict.
Precedence from now on: **ENGINEERING-STANDARDS.md → this file → Requirements v1.3 → Technical Spec → README → prototype**.

Status key: **FIXED** = decided, build it this way · **CONFIRM** = built this way by default, owner/CA to confirm before go-live.

---

## A. Accounting correctness

### A1. Vendor bill payments double-count project cost — FIXED
**Bug:** A bill posts `Dr Project cost / Cr AP`. Paying it also "posts an approved project expense" (README §7, prototype `billId` expense). In a journal that books the cost twice and AP is never cleared.
**Fix:**
- Vendor payment posts only `Dr AP (vendor) / Cr Bank|Cash|UPI`.
- No `expense` row is created. The project ledger shows the payment as a read-only row sourced from `vendor_payment` (type = category of the bill, `Bill/ref` = bill no).
- Project cost is recognised once, on the bill date.

### A2. Recoverable GST counted as project cost — FIXED
**Bug:** Prototype P&L counts the bill-linked expense amount, which includes GST. Where ITC is eligible, that GST is an asset (input credit), not cost. Margins are understated by up to 18% of purchases.
**Fix:**
- ITC-eligible bill: cost = taxable value; GST → Input CGST/SGST/IGST.
- ITC-ineligible bill (no vendor GSTIN or blocked): cost = taxable + GST.
- Direct expenses (petty site spends): cost = full amount paid (no ITC captured in v1).

### A3. P&L definition rewritten to come from the journal — FIXED
Old: "Cost = approved expenses + unpaid vendor bills" (a cash/accrual hybrid that only works without double entry).
New: **Project P&L = SUM(journal_line) by `project_id`** over income and expense accounts.
- Revenue = invoice taxable value, less credit notes. Proformas and advances are never revenue.
- Cost = approved expenses + bills (per A2) + daily wages + contractor payments + project-tagged payroll.
- Pending and rejected expenses post nothing.

### A4. Receipts table has two incompatible designs — FIXED
**Bug:** §4 links receipts via `receipt_allocation`; §4a adds a CHECK on `receipts.invoice_id`, which doesn't exist.
**Fix:** one design.
```sql
receipt_allocation(id, receipt_id FK, invoice_id FK NULL, proforma_id FK NULL,
                   amount NUMERIC(14,2), applied_at DATE NULL,
                   CHECK (invoice_id IS NOT NULL OR proforma_id IS NOT NULL))
```
- Advance on a proforma: `proforma_id` set, `invoice_id` NULL → `Dr Bank / Cr Customer advances`.
- On conversion: set `invoice_id` and `applied_at` on the same row (proforma link kept for history) → `Dr Customer advances / Cr AR`.
- Drop `receipts.proforma_id` and the §4a CHECK.

### A5. "One invoice per project" contradicts stage proformas and service invoices — FIXED
**Bug:** Tech Spec §1 says one invoice per project, but each stage proforma (30/40/50%) converts into its own `CSD/` invoice, and support tickets raise invoices against the same project.
**Fix:** a project can have **many** tax invoices. Remove the one-invoice rule; nothing in the schema enforces it anyway.

### A6. Rounding mismatch — FIXED
Prototype rounds bill GST to whole rupees; the spec says 2 dp.
**Fix:** every tax and amount is computed per line to 2 dp (`NUMERIC(14,2)`, round half-up). Each document total (invoice, bill, proforma, quote, credit note) is rounded to the nearest rupee with a `round_off` line posted to a *Round off* account.

### A7. GST on advances hard-coded at 18/118 — FIXED
**Fix:** Table 11A tax = `amount × r / (100 + r)`, where `r` is the proforma's GST rate (from its lines; mixed rates are split pro rata by line value).

### A8. All statutory series must be gapless — FIXED
GST law requires consecutive numbering for credit notes and receipt vouchers too, not only invoices.
**Fix:** `CSD/`, `CN/`, `RCT/`, `PI/` all use the locked `number_series` row inside the insert transaction. `QT/`, `PO/`, `TKT-`, `CSD-PRJ-` use the same mechanism (simpler to have one code path).

---

## B. Schema and spec contradictions

| # | Bug | Fix | Status |
|---|---|---|---|
| B1 | `app_user.mfa_enabled DEFAULT true`, but auth is email + password only | Drop the column. No OTP/MFA in v1. | FIXED |
| B2 | `role` CHECK has no Asst. Manager | `role IN ('owner','admin','manager','asstmgr','site')` | FIXED |
| B3 | Tech Spec rights table lists 14 modules; Requirements 2.3 lists 21 | Use Requirements 2.3: dashboard, projects, contacts, quotes, proformas, invoices, receipts, pos, bills, expenses, approvals, pnl, banking, outstanding, gst, reports, payroll, inventory, tickets, warranty, kb. User drawer shows 21 rows. | FIXED |
| B4 | Admin's support rights differ between documents | Requirements wins: Admin = View on tickets, warranty, kb. | FIXED |
| B5 | `contact` table (typed) **and** a separate `vendors` table | Keep only `contact` with `type`. Drop `vendors`. Name unique per `(company_id, type)`. | FIXED |
| B6 | `expense.attachment_key NOT NULL` vs migrated Excel rows with no photo | Column nullable. App rule: required when `company.require_bill_attachment` and `migrated = false` and `source = 'manual'`. Add `expense.migrated BOOL DEFAULT false`. | FIXED |
| B7 | "Paid by" list: Saravanan/Shiva/Udhaya/Guru/Arun (Tech Spec) vs Saravanan/Shiva/Admin/Site Engineer (README) | Settings master `paid_by_label(id, name, active, sort)`, seeded with all six: Saravanan, Shiva, Udhaya, Guru, Arun, Admin. Owner edits it in Settings. | CONFIRM names |
| B8 | Prototype login asks for a 6-digit OTP | Prototype is stale. Build single-step email + password per Requirements. | FIXED |
| B9 | START HERE says Next.js route handlers; Tech Spec says NestJS/Django | One stack, see section D. | FIXED |
| B10 | Expenses can be auto-created by bills, payroll and contracts, with no source field | Add `expense.source ENUM('manual','payroll_wage','contract_payment','visit')` + `source_id`. Edit/delete is allowed only on `manual` and `visit`. | FIXED |

---

## C. Business-rule conflicts

### C1. "Every expense by a non-owner needs approval" vs auto-approved system postings — SUPERSEDED
> **Superseded by ENGINEERING-STANDARDS §0 H2:** threshold approvals for vendor/contractor payments, salary-rate changes and large discounts. The text below is kept for history.

**Bug:** The prototype auto-approves daily-wage payments, contractor payments and bill payments made by the Admin, which breaks the owner's "every expense" rule.
**Default built:**
- Free-form expenses (desktop drawer, ledger grid, mobile, visit cost) → **Pending** unless the user has `approvals = full`.
- Payroll runs, wage payments and contractor payments → post directly. They are gated by the `payroll` right, and every one is listed in a daily **"Posted without approval"** digest on the owner's dashboard.
- Vendor payments → post directly (they settle a bill; they are not new costs, see A1).

Owner to confirm, or switch the flag `company.approve_system_postings = true` to route those through Approvals too.

### C2. Missing Indian statutory items — built in v1 as switchable features — CONFIRM with CA
| Item | What's built | Default |
|---|---|---|
| **TDS u/s 194C** on contractor / subcontractor payments | `contract_job.tds_percent` (1% individual/HUF, 2% others) and vendor-level TDS on bills. Payment posts `Dr Cost / Cr Bank (net) / Cr TDS payable`. TDS register report. | On |
| **Tamil Nadu Professional Tax** on salaried staff | `employee.pt_amount` per half-year, deducted in the September and March runs. Posts to *PT payable*. | On |
| **Reverse charge (RCM)** on transport from unregistered GTAs | `bill.reverse_charge BOOL`. Posts `Dr Input IGST/CGST/SGST / Cr RCM output liability`. Shown in GSTR-3B 3.1(d) and 4(A)(3). | Off |

Building these hooks now costs about 2 days. Retrofitting them after go-live means migrating posted journals.

---

## D. Stack (final)

- **App:** Next.js 15 (App Router) + TypeScript + Tailwind, with tokens from README "Design tokens".
- **API:** Next.js route handlers under `/api/v1`, with all business logic in `packages/core` (pure TS services). The handlers stay thin.
- **DB:** PostgreSQL 16, SQL-first migrations (ADR 0001), optional Drizzle query layer. RLS on `company_id`. A balanced-journal trigger.
- **Jobs:** BullMQ worker (PDF render, GSTR exports, notifications digest).
- **Files:** S3-compatible private bucket, pre-signed URLs, server-side EXIF strip and re-encode.
- **Auth:** argon2id; 15-min access JWT + rotating httpOnly refresh cookie; 30-min idle timeout; 5 failures → 15-min lock.
- **Mobile:** same app, `/m` routes, PWA with an IndexedDB offline queue and `Idempotency-Key`.
- **Tests:** Vitest (core money, GST, numbering, permissions, journal) + Playwright (the 12 UAT scenarios).

```
cityscape-books/
  apps/web/            Next.js UI + /api/v1 route handlers + /m PWA
  apps/worker/         BullMQ jobs
  packages/core/       domain services: posting, gst, numbering, can(), sla
  packages/db/         Drizzle schema, migrations, seed, RLS policies
  packages/ui/         design-token components (table, drawer, chips, pills)
  docs/                handoff/, SPEC-FIXES-v1.4.md
```

---

## E. Guard-rails (these get unit tests in Phase 1)

1. The journal trigger rejects any journal where `SUM(debit) ≠ SUM(credit)`.
2. Any write with `txn_date ≤ lock_date` → HTTP 423, for every role including owner.
3. `can(user, module, level, projectId)` is the only permission check, and it is called by every handler.
4. Responses are serialised through a `pnl` filter that strips `profit`, `margin` and `net` server-side.
5. Number allocation and the document insert happen in one transaction; the test fires 50 concurrent inserts and checks there are no gaps or duplicates.
6. Pending and rejected expenses never create journal lines.
