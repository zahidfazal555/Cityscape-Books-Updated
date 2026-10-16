# Cityscape Books — Technical Specification
Custom accounting & project-costing system for **Cityscape Decors** (Interiors & Construction). The clickable prototype `Cityscape Books.dc.html` is the source of truth for screens, copy and behaviour; this document is what engineering builds the production system from.

---

## 1. Scope (v1)
| # | Module | Prototype screen |
|---|---|---|
| 1 | Sales invoices & client receipts | Invoices, Invoice view, Client receipts |
| 2 | Purchase bills & expenses | Purchase bills, Expenses, Approvals, Project ledger grid |
| 3 | GST reports | GST returns (GSTR-1, GSTR-3B, ITC register, HSN summary, GSTR-1 JSON) |
| 4 | Cash, bank & UPI | Cash, bank & UPI (account registers, spend by staff) |
| 5 | Client & supplier outstanding | Outstanding (ageing: current / 1–30 / 31–60 / 61–90 / 90+) |
| 6 | Project-wise income & expense | Project ledger, Reports → Project income & expenses |
| 7 | Project-wise P&L | Project → Profit & loss tab, Reports → Project P&L (**owner only**) |
| 8 | Payroll | Payroll (monthly staff, daily-wage labour, per-job contractors) |
| 9 | Inventory | Inventory (material purchases per project — purchase tracking only) |

**Confirmed business rules (from client Q&A)**
- One invoice per project; many advance/stage receipts against it.
- "Paid by" (Saravanan / Shiva / Udhaya / Guru / Arun) is a **label** on each expense — no petty-cash wallets.
- **Every** expense entered by a non-owner needs **owner approval** before it posts to the books.
- **Bill photo is mandatory** for every expense (configurable flag `require_bill_attachment`, default true).
- Expense entry: both spreadsheet-style grid (project ledger) and form (drawer / mobile).
- Categories: Material, Labour, Subcontract (FC), Transport, Fuel, Miscellaneous, Incentives, Site visit, Rent/Equipment.
- Regular GST; some clients outside Tamil Nadu → CGST+SGST intra-state, IGST inter-state, decided by client state vs company state (33).
- Payroll: monthly salaried, daily-wage labour, contractors per job. No PF/ESI in v1.
- Project budgets with alerts at **85%** and **>100%**.
- Notifications: **in-app only** in v1.
- Site engineers use **mobile** (responsive web / PWA) with camera capture.
- P&L visible to **Owner only**.

---

### 1a. Added in v1.1: quotations, proformas, purchase orders, contacts, trial balance
| Module key | Screen | Posts to ledger? |
|---|---|---|
| `contacts` | Clients & vendors master | No |
| `quotes` | Quotations + revisions | No |
| `proformas` | Proforma invoices + advances | Advances only (Customer advances liability) |
| `pos` | Purchase orders → bills | No (commitment) |
| — | Reports → Trial balance (`pnl` right) | Read-only over the journal |

Document chain: **Quotation → (accept) Project → Proforma(s) → Tax invoice ← advances carried over → Receipts**. Purchase side: **PO → Bill(s) → Vendor payment**.

---

## 2. Architecture
```
 Browser (desktop)  ─┐
 Mobile PWA (site)  ─┼─ HTTPS ─▶  API (REST, JSON)  ─▶  PostgreSQL 16
                     │            Node.js (NestJS) or     (primary + read replica)
                     │            Django/DRF               │
                     │              │                      └─ nightly encrypted backups (35-day PITR)
                     │              ├─▶ Object storage (S3-compatible, private) — bill photos, invoice PDFs
                     │              ├─▶ Job queue (Redis/BullMQ) — PDF render, GSTR exports, reminders
                     │              └─▶ Transactional email (invites, password reset)
```
- **Frontend:** React + TypeScript, server-rendered tables with virtualised scrolling for ledgers; installable PWA for site engineers (offline draft queue, camera capture).
- **Hosting:** India region (data residency), e.g. AWS ap-south-1 (Mumbai).
- **Environments:** dev → staging → production; migrations via versioned SQL (Prisma/Flyway/Django migrations).
- **Money:** store as `NUMERIC(14,2)` — never floats. All rounding at line level to 2 dp; invoice totals rounded to nearest rupee with a `round_off` line.

---

## 3. Accounting model (Zoho Books-style double entry)
Every business document posts a balanced journal. Screens are views over documents; reports are views over the journal.

| Document | Debit | Credit |
|---|---|---|
| Sales invoice | Accounts Receivable (client) | Sales – Works Contract; Output CGST/SGST or IGST |
| Client receipt | Bank / Cash / UPI clearing | Accounts Receivable (client) |
| Purchase bill | Project cost (category); Input CGST/SGST or IGST (if vendor GSTIN) | Accounts Payable (vendor) |
| Vendor payment | Accounts Payable (vendor) | Bank / Cash / UPI |
| Direct expense (approved) | Project cost (category) | Bank / Cash / UPI |
| Payroll run | Salaries expense | Salaries payable; TDS payable; Staff advances |
| Daily wages paid | Project cost – Labour | Cash / UPI |

- Pending / rejected expenses create **no** journal lines.
- Every journal line carries `project_id` (nullable for overheads) → project P&L = SUM by project.
- **Period lock:** `company.lock_date`; any create/update/delete with `txn_date <= lock_date` is rejected (HTTP 423) for all roles. Unlock is owner-only and audited.
- **Numbering:** gapless per financial year, per series: `CSD/26-27/0001` (invoices), `RCT/26-27/0001` (receipts), `CSD-PRJ-0001` (projects). Generated inside the insert transaction with `SELECT … FOR UPDATE` on a `number_series` row. Invoices are never deleted — only cancelled (credit note).

---

### 3a. Additional posting rules
| Event | Debit | Credit |
|---|---|---|
| Advance received against proforma | Bank / Cash | Customer advances (liability) |
| Proforma converted to tax invoice | Customer advances | Accounts receivable (for the advance applied) |
| Quotation / PO created, sent, accepted | — no journal — | |

GST on an advance is a liability from the receipt date (GSTR-1 Table 11A). Reverse it in 11B in the month the invoice is raised.

## 4. Database schema (PostgreSQL)
All tables: `id UUID PK`, `company_id UUID FK` (multi-company ready), `created_at`, `created_by`, `updated_at`, `updated_by`, `deleted_at` (soft delete where allowed). Row-level security on `company_id`.

```sql
company(id, name, legal_name, gstin, state_code, address, phone, email,
        bank_name, bank_acc, bank_ifsc, bank_branch, fy_start_month SMALLINT DEFAULT 4,
        lock_date DATE, require_bill_attachment BOOL DEFAULT true)

app_user(id, company_id, name, email CITEXT UNIQUE, phone, password_hash, -- argon2id
         role TEXT CHECK (role IN ('owner','admin','manager','site')),
         is_active BOOL, mfa_enabled BOOL DEFAULT true, last_login_at, failed_attempts INT, locked_until)
user_project(user_id, project_id, PRIMARY KEY(user_id, project_id))   -- scoping for site/manager
session(id, user_id, refresh_token_hash, ip, user_agent, created_at, expires_at, revoked_at)

contact(id, company_id, type TEXT CHECK (type IN ('client','vendor','employee','contractor')),
        name, gstin, pan, state, state_code CHAR(2), address, phone, email, payment_terms_days INT)

project(id, company_id, code TEXT UNIQUE, name, client_id FK contact, site_address,
        status TEXT CHECK (status IN ('active','on_hold','completed','cancelled')),
        start_date, end_date, contract_value NUMERIC(14,2), cost_budget NUMERIC(14,2),
        manager_id FK app_user, engineer_id FK app_user)

expense_category(id, company_id, name, gl_account_id, sort)          -- the 9 categories

account(id, company_id, code, name, type TEXT CHECK (type IN
        ('asset','liability','equity','income','expense')), subtype, is_system BOOL)
payment_account(id, company_id, account_id, kind TEXT CHECK (kind IN ('cash','bank','upi')),
        name, bank_acc_last4, opening_balance, opening_date)

invoice(id, company_id, number TEXT, fy TEXT, project_id, client_id, invoice_date, due_date,
        place_of_supply CHAR(2), is_inter_state BOOL, status TEXT, -- draft/sent/partially_paid/paid/overdue/cancelled
        subtotal, cgst, sgst, igst, round_off, total, balance, notes, pdf_object_key,
        UNIQUE(company_id, fy, number))
invoice_line(id, invoice_id, sort, description, sac_hsn, qty NUMERIC(12,3), unit, rate, gst_rate, amount)

receipt(id, company_id, number, fy, client_id, project_id, receipt_date, amount,
        mode TEXT CHECK (mode IN ('bank','upi','cash','cheque')), reference, received_by_label,
        payment_account_id)
receipt_allocation(receipt_id, invoice_id, amount)                   -- supports one receipt → many invoices later

bill(id, company_id, vendor_id, vendor_bill_no, project_id, bill_date, due_date,
     category_id, is_inter_state BOOL, taxable, gst_rate, cgst, sgst, igst, total, balance,
     itc_eligible BOOL, attachment_key, status)
vendor_payment(id, company_id, vendor_id, payment_date, amount, mode, reference, payment_account_id)
vendor_payment_allocation(payment_id, bill_id, amount)

expense(id, company_id, project_id, txn_date, particulars, category_id, amount,
        paid_by_label TEXT, mode TEXT CHECK (mode IN ('upi','cash','bank')), paid_to,
        payment_account_id, attachment_key NOT NULL,                  -- enforced when company flag on
        status TEXT CHECK (status IN ('pending','approved','rejected')),
        submitted_by FK app_user, approved_by FK app_user, approved_at, reject_reason,
        client_entry_id UUID UNIQUE)                                  -- idempotency for offline PWA sync

journal(id, company_id, txn_date, source_type, source_id, narration, posted_at)
journal_line(id, journal_id, account_id, project_id NULL, contact_id NULL,
             debit NUMERIC(14,2) DEFAULT 0, credit NUMERIC(14,2) DEFAULT 0,
             CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0)))
-- trigger: SUM(debit) = SUM(credit) per journal, else rollback

employee(id, company_id, contact_id, type TEXT CHECK (type IN ('salaried','daily','contractor')),
         designation, monthly_gross, daily_rate, tds_percent, default_project_id, is_active)
attendance(id, employee_id, project_id, work_date, days NUMERIC(3,1))
payroll_run(id, company_id, period CHAR(7), status TEXT, processed_by, processed_at)
payslip(id, payroll_run_id, employee_id, gross, tds, advance_recovery, net, pdf_object_key)
staff_advance(id, employee_id, date, amount, recovered NUMERIC(14,2))
contract_job(id, company_id, contractor_id, project_id, work_description, value, paid)

item(id, company_id, name, category, unit, hsn)
purchase_line(id, bill_id NULL, expense_id NULL, item_id, project_id, qty, rate, amount, vendor_id)

notification(id, company_id, user_id, type, title, body, link, read_at, created_at)
audit_log(id BIGSERIAL, company_id, user_id, at TIMESTAMPTZ, ip, action, entity, entity_id,
          before JSONB, after JSONB)                                  -- append-only; no UPDATE/DELETE grant
number_series(company_id, series, fy, next_value, PRIMARY KEY(company_id, series, fy))
```

**Key indexes:** `expense(project_id, txn_date)`, `expense(status) WHERE status='pending'`, `journal_line(project_id, account_id)`, `invoice(client_id, status)`, `bill(vendor_id, status)`, `audit_log(entity, entity_id)`.

---

### 4a. Additional tables
```sql
vendors (id, name UNIQUE, gstin, state, state_code CHAR(2), phone, address)
quotations (id, number TEXT, revision INT DEFAULT 0, client_id FK, title, site, quote_date, valid_till,
            discount_pct NUMERIC(5,2) CHECK (0..50), terms, status ENUM('draft','sent','accepted','declined'),
            project_id FK NULL, UNIQUE(company_id, number))      -- 'expired' is derived: status='sent' AND valid_till < today
quotation_revisions (id, quotation_id FK, revision INT, snapshot JSONB, total NUMERIC(14,2), created_at)
quotation_lines / proforma_lines / po_lines (id, parent_id FK, sort, description, sac_hsn, qty NUMERIC(12,3), unit, rate NUMERIC(14,2))
proformas (id, number TEXT UNIQUE per FY, project_id FK, quotation_id FK NULL, stage, pf_date, due_date,
           status ENUM('draft','sent','converted','cancelled'), invoice_id FK NULL, converted_at)
purchase_orders (id, number TEXT UNIQUE per FY, vendor_id FK, project_id FK, po_date, deliver_by,
                 gst_rate NUMERIC(4,2), terms, status ENUM('draft','issued','cancelled'))
ALTER TABLE receipts ADD proforma_id FK NULL, CHECK (invoice_id IS NOT NULL OR proforma_id IS NOT NULL);
ALTER TABLE invoices ADD quotation_id FK NULL, ADD proforma_id FK NULL;
ALTER TABLE bills    ADD purchase_order_id FK NULL;
ALTER TABLE projects ADD quotation_id FK NULL;
```
Number series `QT/`, `PI/`, `PO/` use the same gapless per-FY `number_series` row-lock as invoices. Revisions reuse the quote number.

## 5. Users, roles & rights (owner admin panel)
Rights are **per user**, not per role. A role is only a template that pre-fills a new user's rights; the owner can then change any module for that person.

**Levels** (ordered): `none` < `view` < `edit` (create & change) < `full` (also delete / cancel).
Some modules allow only a subset of levels: Dashboard, Outstanding, Reports → none/view · Approve expenses → none/full · Profit & margins → none/view.

| Module key | Label | Owner | Admin | Project manager | Site engineer |
|---|---|---|---|---|---|
| dashboard | Dashboard | view | view | view | none |
| projects | Projects & ledger | full | full | edit | view |
| invoices | Invoices & credit notes | full | full | edit | none |
| receipts | Client receipts | full | full | edit | none |
| bills | Purchase bills & vendor payments | full | full | edit | none |
| expenses | Expenses | full | full | edit | edit |
| approvals | Approve expenses | full | none | none | none |
| pnl | Profit, margins & net value | view | none | none | none |
| banking | Cash, bank & UPI | full | full | none | none |
| outstanding | Outstanding | view | view | view | none |
| gst | GST returns | full | full | view | none |
| reports | Reports | view | view | view | none |
| payroll | Payroll | full | full | none | none |
| inventory | Inventory | full | full | edit | view |
| *(settings)* | Users & security | **owner only — not grantable** | | | |

**Rules**
- Owner always has every right; the owner row can't be edited or deactivated.
- **Project scope:** each user has `All` projects or a list of project IDs. Every query on projects, invoices, receipts, expenses, bills, labour, contracts and items is filtered by that scope.
- Expenses created by anyone **without** `approvals=full` are saved as `pending`. Editing an approved expense without that right sends it back to `pending`.
- `pnl=none` must strip `profit`, `margin`, `net` and the P&L report from **API responses**, not just hide them in the UI.
- Role `site` gets the mobile UI (expense capture only).
- Deactivated users can't sign in; their records and audit entries stay.

**Schema additions**
```sql
user_permission(user_id FK app_user, module TEXT, level TEXT CHECK (level IN ('none','view','edit','full')),
                PRIMARY KEY(user_id, module))
role_template(role TEXT, module TEXT, level TEXT, PRIMARY KEY(role, module))   -- seeds the table above
-- app_user.projects_all BOOL; scoped projects in user_project (see §4)
```
**Endpoints:** `GET/POST /users`, `PATCH /users/:id` (name, email, phone, role, projects_all, project_ids[], permissions{module:level}), `POST /users/:id/deactivate|activate`, `GET /role-templates`. All owner-only. Every change is written to `audit_log`.

Enforce in one server-side policy function `can(user, module, level, projectId?)`, used by every endpoint and mirrored in the client only for showing and hiding UI.

**Asst. Manager · Project Management** (`asstmgr`, added v1.2): supports the Project Manager. Its default rights:
- **Create & edit:** projects & ledger, quotations, purchase orders, purchase bills, expenses, inventory.
- **View only:** clients & vendors, proforma invoices, tax invoices, receipts, outstanding, reports.
- **No access:** approvals, profit & loss, banking, GST, payroll, users.

Its expenses go to the owner for approval. The owner can scope it to selected projects.

## 6. API (REST, `/api/v1`, JSON, cursor pagination)
```
POST   /auth/login                 {email,password} → access(15m) + refresh(7d, httpOnly cookie)   (rate-limited)
POST   /auth/invite/accept  · POST /auth/password/forgot  · POST /auth/password/reset
POST   /auth/refresh  · POST /auth/logout · GET /me

GET    /dashboard                  KPIs, alerts, project rows, category split, ageing
GET    /projects  · POST /projects · GET/PATCH /projects/:id
GET    /projects/:id/ledger        running-balance ledger (receipts + approved/pending expenses)
GET    /projects/:id/pnl           owner only

GET/POST /invoices  · GET/PATCH /invoices/:id (only while no receipts & after lock date) · POST /invoices/:id/cancel → credit note CN/26-27/#### · GET /invoices/:id/pdf
GET/POST /receipts
GET/POST /bills · PATCH/DELETE /bills/:id (delete only if unpaid) · POST /bills/:id/payments
POST   /contract-jobs/:id/payments · POST /attendance/:workerId/increment
PATCH  /banking/transactions/:key/reconcile {reconciled:bool}
GET    /search?q= · GET /notifications
GET    /<any list>?format=csv
GET/POST /expenses  · GET /expenses/:id
PATCH  /expenses/:id · DELETE /expenses/:id (full; not if linked to a bill/contract payment)
POST   /expenses/:id/approve · POST /expenses/:id/reject {reason} · POST /expenses/approve-bulk {ids[]}
POST   /attachments/presign        → {upload_url, object_key}  (image/jpeg|png|pdf, ≤10 MB)

GET    /banking/accounts · GET /banking/accounts/:id/transactions
GET    /outstanding/receivables · GET /outstanding/payables   ?as_of=
GET    /gst/gstr1?period=2026-09   (+ ?format=json → GSTN offline-tool schema)
GET    /gst/gstr3b?period= · GET /gst/itc?period= · GET /gst/hsn?period=
GET    /reports/project-income-expense · /reports/project-pnl · /reports/category-spend   (?format=xlsx|pdf)

GET/POST /payroll/runs · POST /payroll/runs/:id/process · GET /payslips/:id/pdf
GET/POST /attendance · POST /daily-wages/pay
GET/POST /contract-jobs
GET    /inventory/purchases?project_id=
GET/POST/PATCH /users · GET /audit-log · GET/PATCH /settings (lock_date owner-only)
GET    /notifications · POST /notifications/:id/read
```
- Validation errors → `422 {field, message}`; period lock → `423`; permission → `403`; optimistic concurrency via `If-Match` / `version`.
- All writes accept `Idempotency-Key` header (PWA retries).

---

### 6a. Additional endpoints
```
GET/POST/PATCH /vendors, /clients                          contacts
GET/POST       /quotations            PATCH /quotations/:id (draft only)
POST /quotations/:id/send | /accept {project{name,site,budget}} | /decline | /revise
POST /quotations/:id/proforma {pct, stage, due}            quotes:edit + proformas:edit
GET/POST       /proformas             PATCH /proformas/:id (no receipts)
POST /proformas/:id/send | /cancel | /convert              convert needs invoices:edit; one DB transaction
GET/POST       /purchase-orders       POST /purchase-orders/:id/issue | /cancel | /bill
GET            /reports/trial-balance?as_of=               pnl
```

## 7. Security
| Control | Requirement |
|---|---|
| Authentication | Email + password only (argon2id, min 12 chars, breached-password check). **No SMS / OTP.** Invite and reset links by email, single-use, 24-hour expiry. |
| Sessions | 15-min JWT access token + rotating refresh token (httpOnly, Secure, SameSite=Strict). **30-min idle timeout.** Revoke all sessions on password change. |
| Lockout | 5 failed logins → 15-min lock; owner notified in-app. |
| Authorisation | Server-side RBAC + project scoping + Postgres RLS on `company_id`. |
| Transport | TLS 1.2+ only, HSTS, CSP, X-Frame-Options DENY. |
| Data at rest | Encrypted DB volumes and object storage (AES-256). Bill photos via short-lived pre-signed URLs only. |
| Input | Parameterised queries / ORM only; file uploads MIME-sniffed + size-capped, images re-encoded (strip EXIF GPS). |
| Audit | Append-only `audit_log` with before/after JSON for every create/update/approve/reject/login/logout/lock change. |
| Backups | Nightly encrypted backups + WAL point-in-time recovery, 35-day retention; quarterly restore drill. |
| Secrets | Env-injected from a secrets manager; never in repo. |
| Compliance | OWASP ASVS L2 checklist; dependency scanning (Dependabot/Snyk) in CI; annual pen-test. |

---

## 8. GST logic
- `is_inter_state = client.state_code ≠ company.state_code ('33')`. Intra → CGST 9% + SGST 9%; inter → IGST 18%.
- Default SAC **9954** (construction services); per-line override allowed (e.g. goods supplied with HSN).
- B2B if client GSTIN present, else B2CS. GSTIN validated by regex + checksum.
- ITC eligible only when vendor GSTIN present and bill GST > 0. (v2: reconcile against GSTR-2B import.)
- GSTR-1 JSON export matches the GSTN offline-tool schema (`b2b`, `b2cs`, `hsn`); prototype shows the structure.
- GSTR-3B: 3.1(a) outward taxable, 4(A)(5) ITC, 6.1 net payable — computed per period.

---

## 9. Key workflows
**Expense (site engineer, mobile)** → select site → amount, particulars, category, mode, paid-to → **camera photo (required)** → submit → `status=pending`, in-app notification to owner → owner approves (single/bulk) → journal posted → appears in project ledger balance, banking, reports. Rejected → engineer sees reason.

**Project start** → owner/admin creates project (auto `CSD-PRJ-####`), picks/creates client (state drives GST), sets contract value & cost budget → invoice created from agreement → receipts recorded against it as advances arrive.

**Budget alert** → after each approval, if `spent / cost_budget ≥ 0.85` (first crossing) or `> 1.0` → in-app notification to owner + dashboard banner.

**Month end** → process payroll → review GST → download GSTR-1 JSON → owner sets `lock_date` to month end.

---

## 10. Data migration
Import from the existing Excel trackers (one sheet per project, columns: S.No, Date, Particulars, Type, Receipts, Payments, Paid by, Mode, Paid to). Mapping: `Type` → category; `Receipts` → receipt; `Payments` → approved expense with `attachment_key = NULL` + `migrated = true` flag (exempt from bill requirement). Validate closing balance per sheet matches before go-live.

---

## 11. Non-functional
- p95 API < 300 ms for lists ≤ 500 rows; ledger of 5,000 rows renders < 1 s (virtualised).
- Mobile PWA usable on 3G; offline draft queue with photo; sync on reconnect with idempotency keys.
- Indian formatting everywhere: ₹, lakh/crore grouping (`en-IN`), DD MMM YYYY, FY Apr–Mar.
- Accessibility: WCAG 2.1 AA contrast, 44 px touch targets on mobile, full keyboard support on desktop grid.
- Test coverage: unit tests on GST, numbering, journal balancing, permissions; e2e on the 4 role journeys.

## 14. Support module (v1.3)
### Tables
```sql
tickets (id, number TEXT UNIQUE 'TKT-####', project_id FK NOT NULL, type ENUM('snag','warranty','service','amc','billing','change'),
         subject, description, priority ENUM('urgent','high','normal','low'), status ENUM('open','in_progress','awaiting_client','visit_scheduled','resolved','closed'),
         channel ENUM('phone','walk_in','whatsapp','email','site_visit'), caller_name, caller_phone, assignee_id FK users NULL,
         created_at TIMESTAMPTZ, first_response_at, resolved_at, closed_at, chargeable BOOL, coverage ENUM('warranty','amc','contract','chargeable','na'),
         rating SMALLINT CHECK (1..5) NULL, rating_comment, rating_by, rating_at)
ticket_events (id, ticket_id FK, kind ENUM('system','reply','call','note'), body TEXT, author_id FK, created_at)   -- append-only
site_visits (id, ticket_id FK, visit_date DATE, slot ENUM('morning','afternoon','evening'), engineer_id FK users, instructions,
             status ENUM('scheduled','completed','cancelled'), work_done, cost NUMERIC(12,2), expense_id FK NULL, completed_at)
visit_photos (id, visit_id FK, phase ENUM('before','after'), storage_key, taken_at, uploaded_by)   -- private bucket, pre-signed URLs, EXIF GPS stripped
reply_templates (id, title, body)          kb_articles (id, title, category, body, updated_at, updated_by)
ALTER TABLE projects ADD handover_date DATE NULL, ADD warranty_months SMALLINT DEFAULT 12, ADD amc_until DATE NULL;
ALTER TABLE expenses ADD ticket_id FK NULL;  ALTER TABLE quotations ADD ticket_id FK NULL;  ALTER TABLE invoices ADD ticket_id FK NULL;
```
### Rules
- **SLA due times:**
  - \`resp_due = created_at + {1,4,8,24}h\` and \`resolve_due = created_at + {4,24,72,168}h\`, by priority.
  - Stored as generated columns, so dashboards can query breaches.
  - Prototype uses calendar hours. Business-hours calendars and pausing the clock while "Awaiting client" are v2.
- **First response:** \`first_response_at\` is set by the first \`reply\` or \`call\` event, or by resolving.
- **Completing a visit** needs at least 1 before photo, at least 1 after photo and \`work_done\`. If \`cost > 0\`, it also needs a bill photo. All of this runs in one transaction, with the expense \`status='pending'\` charged to the ticket's project.
- **Coverage** is computed when the ticket is created and stored with it. A later change to the warranty dates doesn't rewrite old tickets.
- **Rights:**
  - Rights modules: \`tickets\`, \`warranty\`, \`kb\`.
  - A site engineer can read and complete only \`site_visits.engineer_id = me\`, regardless of project scope.
- **API:**
  - \`GET/POST /tickets\`
  - \`PATCH /tickets/:id\` (status, priority, assignee, chargeable)
  - \`POST /tickets/:id/events\`
  - \`POST /tickets/:id/visits\`
  - \`POST /visits/:id/complete\` (multipart photos)
  - \`POST /visits/:id/cancel\`
  - \`POST /tickets/:id/rating\`
  - \`GET/POST/PATCH/DELETE /kb\`, \`/reply-templates\`
  - \`PATCH /projects/:id/warranty\`
  - \`GET /reports/support\`

## 12. Out of scope for v1 (candidates for v2)
WhatsApp/email notifications · PF/ESI · multi-warehouse stock & site transfers · GSTR-2B reconciliation · bank statement auto-reconciliation · e-invoicing (IRN) once turnover threshold applies · client portal.

## 13. Open items needed from Cityscape Decors
Registered address, GSTIN, phone, bank details (invoice header placeholders are in the prototype) · invoice terms & conditions text · staff master with salaries · opening balances as on 1 Apr 2026.
