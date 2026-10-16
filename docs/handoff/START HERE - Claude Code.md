# START HERE: building Cityscape Books with Claude Code

## What this is
A custom accounting, project-costing, payroll and customer-support system for **Cityscape Decors** (Interiors & Construction, Chennai). It is modelled on Zoho Books and Zoho Desk. Everything in this folder is a **design reference**: the HTML prototype shows the exact screens, wording and behaviour, but it is not production code. Build a real app that reproduces it.

## Read in this order
1. `Cityscape Books - Requirements.dc.html`: what the system must do, with FR IDs, acceptance criteria and UAT scenarios.
2. `README.md`: screen-by-screen UI spec, interactions and design tokens.
3. `Technical Spec.md`: database schema, posting rules, REST API, security.
4. `Cityscape Books.dc.html`: open it in a browser (`npx serve .`) and click through every role using the demo login.

## Recommended stack (change only with a reason)
- **Frontend:** Next.js (App Router) + TypeScript + Tailwind, using the design tokens from the README. TanStack Table for the ledger grid. A PWA build for the Site Engineer mobile layout.
- **Backend:** Next.js route handlers or NestJS. PostgreSQL with Prisma or Drizzle, and row-level security on `company_id`.
- **Auth:** email + password only (argon2id), no SMS/OTP. Invite and password-reset links by email (any transactional email service). httpOnly refresh cookies.
- **Files:** S3-compatible private bucket with pre-signed URLs for bill photos and visit photos.
- **Hosting:** a managed Postgres (with backups) and an app host in the India region.

## Build phases (each one ends with its UAT scenarios passing)
1. **Foundation:** auth (email + password), users and per-module rights, project scoping, audit log, lock date, number series, app shell (nav, search, notifications), clients & vendors, projects.
2. **Sales:** quotations (revisions), proformas + advances, tax invoices + credit notes, receipts, A4 print/PDF.
3. **Purchases:** purchase orders, bills + vendor payments, expenses with photo + owner approval, Site Engineer mobile expense entry.
4. **Accounts:** double-entry journal posting for every document, banking + reconciliation, outstanding & ageing, GST returns (GSTR-1 JSON, 3B, 11A/11B), reports, P&L, trial balance.
5. **Operations:** payroll (staff, daily wages, contractors), inventory purchases.
6. **Support:** tickets + SLA, site visits with mobile before/after photos, warranty register, knowledge base, ratings, support dashboard.
7. **Go-live:** data migration from the Excel trackers and opening balances, security hardening (OWASP ASVS L2), backups, UAT sign-off.

## Rules that must never break
- Tax invoice numbers are gapless per FY. Invoices are cancelled with a credit note, never deleted.
- Every document posts a balanced journal. The trial balance must always show debits equal to credits.
- Pending expenses are excluded from every balance, report and GST figure until the owner approves them.
- Nothing dated on or before the lock date can be created, edited or deleted.
- Rights and project scope are checked on the server for every request.
- Profit, margin and net value are visible only to users with the `pnl` right.

## First prompt to give Claude Code
> Read START HERE, the Requirements document, README.md and Technical Spec.md in this folder, and open Cityscape Books.dc.html to study the prototype. Then propose the repository structure, the database schema migration for Phase 1, and a task list for Phase 1 mapped to the FR IDs. Don't write feature code until I approve the plan.

## Still needed from Cityscape Decors before go-live
Registered address, GSTIN, phone and bank details · invoice terms · opening balances as on 1 Apr 2026 · client, vendor and staff masters · user names/emails/mobiles · handover and AMC dates of past projects · email sending service · domain name.
