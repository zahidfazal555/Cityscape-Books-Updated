# Handoff: Cityscape Books, accounting & project costing for Cityscape Decors

## Overview
Cityscape Books is a custom accounting and project-costing system for **Cityscape Decors** (Interiors & Construction, Chennai, Tamil Nadu). Its accounting model is based on Zoho Books.
Every rupee is tagged to a client project (`CSD-PRJ-0001` …). The system covers:

1. Sales: quotations (with revisions), proforma invoices, tax invoices, credit notes, client receipts & advances
2. Purchases: purchase orders, purchase bills, vendor payments & site expenses (with owner approval and bill photos)
3. GST: GSTR-1, GSTR-3B summary, ITC register, HSN summary, credit notes, GSTR-1 JSON
4. Cash, bank & UPI registers with statement reconciliation
5. Client & vendor outstanding with ageing
6. Project-wise income & expense ledger (spreadsheet-style entry)
7. Project-wise profit & loss (restricted right)
8. Payroll: monthly staff, daily-wage labour, per-job contractors, payslips
9. Inventory: material purchase tracking per project
10. **Owner admin panel**: create users, assign role and project scope, set rights per module, deactivate users, set the books lock date, view the audit trail

The companion document **`Technical Spec.md`** (in this folder) defines the backend: architecture, double-entry posting rules, PostgreSQL schema, REST API, security controls, GST logic, migration from Excel, and non-functional requirements. Read both documents.

## About the design files
The files in this bundle are **design references created in HTML**. They are a working prototype that shows the intended look, copy, and behaviour. They are **not production code to ship**.

- **The task:** rebuild the prototype as a real application with a real backend, database, authentication and file storage.
- **Stack:** the spec recommends **React + TypeScript** (frontend, plus a PWA for site engineers), **NestJS or Django REST** (API) and **PostgreSQL 16**. Choose the closest equivalent if your team has a standard stack.
- **Prototype data:** all data lives in browser memory/localStorage. Everything under "State" below must move to the server.

## Fidelity
**High-fidelity.** Colours, typography, spacing, copy, validation messages and interactions are final. Recreate the UI to match, using your component library's primitives styled to the tokens below.

## How to run the prototype
Open `Cityscape Books.dc.html` in a browser served from this folder. `support.js`, `cityscape-data.js` and `assets/` must sit next to it.

- **Sign in:** pick any account, press Continue, and enter any 6 digits as the one-time code.
- **Demo accounts:**
  - Owner: Saravanan S
  - Admin: Accounts Admin
  - Project Manager: Shiva
  - Site Engineer (opens the mobile layout)
- **Saving:** changes persist in `localStorage` under key `csd-books-v2`.
- **Reset:** Users & security → Security → Reset demo data.

---

## Layout shell (desktop)
- **Header:** 56px tall, sticky, white, border-bottom `1px #E3E7ED`, padding `0 20px`, gap 16px. Contents, left to right:
  - Logo (24px high), a 1×22px divider, and "Books · FY 2026-27" (13px, `#5B6573`).
  - **Global search:** centred, max 420px, 34px tall, background `#F8FAFC`. Results open in a dropdown grouped Project / Invoice / Bill / Expense.
  - **+ New quick-create menu:** primary button. Its items are filtered by edit rights.
  - **Notifications bell:** 34×34 with a red unread count. The dropdown is 360px wide and covers:
    - pending approvals
    - budget at ≥85% or over 100%
    - overdue invoices and overdue proformas
    - quotes expiring within 3 days, or expired while still Sent
    - bills due within 7 days
  - **"To approve" pill:** shown only to users who can approve.
  - Avatar, name and role, then **Sign out**.
- **Left nav:** 220px wide, white, border-right, sticky, scrolls internally.
  - Group labels: 11px uppercase, `#8A94A6`, letter-spacing .06em.
  - Items: 34px tall, radius 6px. Active item uses background `#E8F0FA`, text `#1F5FAE`, weight 600.
  - Approvals shows an amber count badge.
  - At the bottom, a box reads "Books locked till {date}".
  - Only modules the user can view are listed. **Users & security** is shown to the owner only.
- **Main:** padding `24px 28px 56px`, content max-width 1320px, centred.
- **Page header:** H1 22px/600, subtitle 13px `#5B6573`, primary action on the right.
- **Tables:** CSS grid rows inside a white card (border `1px #E3E7ED`, radius 8px, horizontal scroll with a min-width).
  - Header row: background `#F8FAFC`, 11px/600 uppercase, letter-spacing .05em, `#5B6573`.
  - Body rows: 13px, border-bottom `#EEF1F5`, hover `#F8FAFC`.
  - Totals row: background `#F8FAFC`, weight 600.
  - Numbers: right-aligned, `font-variant-numeric: tabular-nums`.
  - IDs and document numbers: IBM Plex Mono, 11.5–12px.
- **Drawers (all create/edit forms):** fixed right panel, full height.
  - Width 520px (most forms), 560px (project and bill), 660px (user), 760px (invoice).
  - Scrim `rgba(16,24,40,.45)`.
  - Header 56px with a × close button; scrolling body padded 20px; footer with Cancel + primary button.
- **Confirm dialog:** centred, 420px, radius 10px, z-index above drawers. Destructive actions use a red primary `#B42318`.
- **Toast:** bottom-centre, background `#1B2430`, white 13.5px text, auto-hides after 2.8s.

## Screens / views
Each screen lists its purpose, layout and the rules it must follow. Copy is exactly as in the prototype.

### 1. Login
Split layout.
- **Left panel:** background `#EEF4FA` with logo, a 38px/600 headline ("Every site, every rupee, in one set of books.") and a 16px subline.
- **Right panel:** max-width 400px. Work email + password, **Sign in** button. Footnote: "Sign in with your work email and password. Sessions end after 30 minutes idle."
- **No SMS / OTP step.** Login is a single step.
- **Production:**
  - Passwords: argon2id, min 12 characters, breached-password check.
  - Lockout: 5 failed attempts lock the account for 15 minutes and notify the owner.
  - 30-minute idle timeout.
  - New users get an invite link by email to set their password; "Forgot password" sends a reset link by email.
  - The demo account picker is prototype-only; remove it.

### 2. Dashboard
- **Greeting** plus date, then alert banners: amber `#FFF8EB` / `#F3DDAF`, or red `#FEF3F2` / `#F6CFCB`.
  - Pending approvals (approvers only).
  - Budget at ≥85% (amber) or over 100% (red), with a link to open the project.
- **KPI cards:** auto-fit grid, minimum 220px each.
  - Always: Client receivables, Vendor payables.
  - Cash & bank balance, if the user has the banking right.
  - Then either Waiting for your approval (approvers) or Collected this year.
- **Projects table:** #, Project (name + mono code + client), Invoice value, Income · Cr (green `#1E7A4C`), Expense · Dr (red `#B42318`), Net value (**only with the `pnl` right**), Budget-used bar. Clicking a row opens the project.
- **Spend by category:** a conic-gradient donut (150px, 96px hole) with a legend.
- **Receivables ageing:** bars for Current / 1–30 / 31–60 / 61–90 / 90+.

### 3. Projects list
Filter chips: All / Active / Completed. Table columns: ID, Project · client, Site, Status pill, Contract, Received, Budget used.
"+ New project" needs `projects ≥ edit`.

### 4. Project detail
- **Header:** mono code chip, status pill, name, then the meta line: client · site · start · engineer · manager.
- **Actions:**
  - Record receipt (`receipts ≥ edit`)
  - Edit project (`projects ≥ edit`)
  - New invoice (`invoices ≥ edit`)
  - + Add expense (`expenses ≥ edit`)
- **Stats strip:**
  - Cells: Contract, Invoiced, Received · Cr, Spent · Dr, Balance in hand.
  - Profit so far: only with `pnl`.
  - Budget-used cell: stretches to the end of its row.
- **Tabs:**
  1. **Ledger:** spreadsheet layout copied from the client's Excel sheet: S.No, Date, Particulars, Type, Receipts, Payments, Paid by, Mode, Paid to, Bill/ref, Balance.
     - Running balance counts approved entries only. Pending rows are tinted `#FFFAEB` with the label "Awaiting owner approval".
     - **Inline new row:** date, particulars, category select, amount, paid-by select, mode select, vendor, Attach bill, Add row. Enter submits.
     - The inline row is hidden on completed projects and for users without the edit right.
  2. **Spend by category:** 200px donut with per-category bars.
  3. **Invoices & receipts:** invoice cards with a received-progress bar, plus a receipts list.
  4. **Vendor bills.**
  5. **Profit & loss** (`pnl` only):
     - Statement: Revenue billed (excl. GST), less costs by category, unpaid vendor bills accrued, total cost, gross profit and margin.
     - Budget vs actual card.

### 4a. Clients & vendors
Tabs Clients / Vendors. Clients: name + contact, GSTIN (mono), state (code), projects, invoiced, receivable. Vendors: name, GSTIN, state, POs, bills, billed, payable. "+ Add client/vendor" (`contacts ≥ edit`) opens a form: name, contact, phone, GSTIN, state chips, address.
- GSTIN regex `^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`; its first two digits must match the chosen state. Names are unique.
- Vendors typed on a bill or PO are auto-added to the master; picking a known vendor auto-fills the GSTIN.

### 4b. Quotations (`QT/26-27/####`)
- **List:** status chips All / Draft / Sent / Accepted / Declined / Expired; cards for Open quotes, Accepted, Win rate (accepted ÷ (accepted + declined + expired)). Columns: Quote no (· R1 for revisions), Date, Valid till (red when expired), Client · proposal, Project, Amount, Status.
- **Form (drawer, 780px):** client chips, proposal title, site, quote date, valid till, discount % (0–50), line grid (description, qty, unit, rate, amount, ×), live totals with the CGST+SGST or IGST split from the client's state, terms.
- **Status rules:** Draft → Sent → Accepted / Declined. Sent past "valid till" shows as **Expired** (derived, not stored).
  - Draft: Edit, Delete (`quotes = full`), Mark as sent.
  - Sent / Expired: Revise, Mark declined, Mark accepted (Sent only). Declined: Revise & resend.
  - **Revise** keeps the same number, increments `rev`, pushes the previous version {rev, date, total, status} into `history` and resets the quote to Draft. The view shows the full revision history.
- **Accept → create project:** a form pre-filled with the title and site, plus a cost budget (default 75% of the quote, with live planned margin). Contract value = quoted taxable value. Creates `CSD-PRJ-####` linked by `quoteId`.
- **Accepted:** Open project, Create proforma (30 / 40 / 50 / 100% of the quote, stage name, due date), Create tax invoice (opens the invoice drawer with the quote lines, discount applied to the rates).
- **View:** same A4 layout as the tax invoice, titled QUOTATION, with a status banner, linked documents (project, proformas, invoices) and revision history.

### 4c. Proforma invoices (`PI/26-27/####`)
- **Purpose:** advance or stage payment requests. **Not a tax invoice.** Excluded from receivables, ageing, revenue, P&L and the GSTR-1 B2B table.
- **List:** chips All / Draft / Sent / Partially paid / Paid / Overdue / Converted / Cancelled; cards for Awaiting payment, Advances held, Converted.
- **Form:** project chips, stage name, date, payment due, lines; the GST split comes from the project's client.
- **Advances:** "Record advance" opens the receipt drawer. Its picker lists open tax invoices **and** open proformas. A receipt against a proforma stores `pfId` and posts Dr Bank / Cr *Customer advances* (liability). The project shows "₹X held as customer advance".
- **Convert to tax invoice** (`invoices ≥ edit`, today after the lock date): creates the next `CSD/26-27/####` with the same lines (`pfId`, `quoteId` linked), re-points every advance receipt to the new invoice (`inv` set), and sets the proforma to Converted. Journal: Dr Customer advances / Cr Accounts receivable for the advance amount.
- Edit and Cancel are only allowed while no advance has been received.
- **GST on advances (services):** tax is due when the advance is received. GST screen table **11A** = advances received this month and not invoiced in the same month (tax = amt × 18/118, split by place of supply); **11B** = earlier advances adjusted against invoices raised this month (negative). The net goes into GSTR-3B 3.1(a) as a separate row.

### 5. Tax invoices list & invoice view
- **List columns:** No, Date, Client, Project, Tax type, Amount, Balance due, Status. Statuses: Unpaid / Partially paid / Paid / Overdue / Cancelled. The list has an Export CSV button.
- **View:** printable A4-style GST tax invoice.
  - Logo, company address, GSTIN, "TAX INVOICE" with the number.
  - Bill-to block with GSTIN; invoice/due date, place of supply, project.
  - Line table: #, Description, SAC 9954, Qty, Unit, Rate, Amount.
  - Taxes: CGST 9% + SGST 9% if the client is in Tamil Nadu (state code 33), otherwise IGST 18%.
  - Total, amount in words (Indian system: Crore / Lakh / Thousand), bank details, payments received, signature block.
- **Actions:**
  - **Edit:** only if there are no receipts and the date is after the lock date.
  - **Cancel invoice:** `invoices = full`, no receipts. Issues credit note `CN/26-27/####`. **Invoices are never deleted.**
  - **Delete a receipt:** `receipts = full`, after the lock date.
  - **Print / PDF.**
- **Numbering:** `CSD/26-27/0001`, gapless within each financial year.

### 6. Client receipts
- **Mode totals:** Bank / UPI / Cash / Cheque.
- **Table:** receipt no `RCT/26-27/####`, client · project, invoice, mode, reference, received by, amount.
- **Form:** pick the open invoice, then date, amount (with a "Full ₹x" shortcut), mode chips, reference (label changes with mode), received by.
- **Validation:**
  - Amount must be > 0 and ≤ the invoice balance.
  - Reference is required unless the mode is cash.
  - Date must be after the lock date.

### 6a. Purchase orders (`PO/26-27/####`)
- **List:** chips All / Draft / Issued / Partly billed / Billed / Cancelled; cards for Open orders (unbilled value), Billed against POs, Drafts. Columns: PO no, Date, Vendor + GSTIN, Project, Deliver by (red if overdue and not billed), Amount, Billed, Status.
- **Form:** vendor (datalist from the master, GSTIN auto-fill), GSTIN, deliver-to project, GST rate chips 0/5/12/18/28, PO date, deliver by, lines, terms. Unregistered vendor → no GST.
- **Status:** Draft → Issued. Billed / Partly billed are derived from the taxable value of linked bills (`bill.poId`). Cancel only when no bills are linked.
- **Convert to bill:** opens the bill drawer pre-filled with vendor, GSTIN, project, rate and the **remaining unbilled** taxable value, linked by `poId`. A PO posts no journal; it's a commitment only.

### 7. Purchase bills & vendor payments
- **Table:** Bill no, Vendor + GSTIN, Project, Date, Due, Amount, GST, Balance, Status, then actions.
- **Row actions:**
  - **Pay:** amount, date, mode, reference, paid by. It increases `bill.paid` **and** posts an approved project expense linked by `billId`.
  - **Edit:** only after the lock date. The new total can't fall below the amount already paid.
  - **Delete:** `bills = full`, unpaid bills only.
- **Bill form:** vendor, GSTIN, bill no, dates, project, category, taxable amount, GST rate chips (0 / 5 / 12 / 18 / 28).
  - IGST if the vendor's GSTIN state is not 33, otherwise CGST + SGST.
  - No GSTIN means no GST and no input credit.

### 8. Expenses
- **Filters:** project, category, status. Shows a live count and total, plus Export CSV.
- **Table columns:** Date, Project, Particulars, Category (colour dot), Paid by, Mode, Paid to, Bill (View opens a lightbox), Amount, Status, Edit/Delete.
- **Edit / Delete:**
  - Edit: `expenses ≥ edit`. Delete: `expenses = full`.
  - Both hidden for dates on or before the lock date.
  - Both hidden for entries auto-created by bill or contractor payments.
- **Expense form (drawer):**
  - Project chips, date, amount, particulars.
  - Category chips (9): Material, Labour, Subcontract (FC), Transport, Fuel, Miscellaneous, Incentives, Site visit, Rent/Equipment.
  - Paid by chips: Saravanan, Shiva, Admin, Site Engineer.
  - Mode: UPI / Cash / Bank. Paid to.
  - **Bill photo required.**
  - Non-approvers see the note: "This goes to the owner for approval…".

### 9. Approvals (`approvals = full`)
Cards showing: bill thumbnail (84px), amount (18px/600), particulars, category · project, paid by · mode · to, submitted by · date. Each card has Reject and Approve buttons; there is also Approve all. Empty state: "All caught up."

### 10. Cash, bank & UPI
- **Account cards:** Cash in hand / HDFC current a/c / UPI. Selecting a card opens its register.
- **Register columns:** Rec. checkbox (statement match), Date, Particulars, Project, Mode, Money in, Money out, Running balance.
- **Status text:** "N entries not yet matched with the statement".
- **Spending by staff:** totals by paid-by label, split UPI / Cash / Bank.

### 11. Outstanding
Tabs for Client receivables and Vendor payables, each with:
- a stacked ageing bar and legend;
- a table with one amount column per bucket, a "days overdue" status (amber > 0, red > 60) and totals;
- Export CSV.

### 12. GST returns
- **Month chips:** Jun–Oct 2026.
- **Cards:** Output tax, Input tax credit, Net payable or ITC carried forward (with the 20th-of-next-month due date).
- **GSTR-3B summary:** 3.1(a) net of credit notes, 4(A)(5) ITC, 6.1 cash payable.
- **GSTR-1 table:** B2B/B2C, POS, CGST/SGST/IGST, with an HSN 9954 summary.
- **Credit notes table.**
- **ITC register:** marks each bill Eligible or No ITC.
- **Downloads:** GSTR-1 JSON (GSTN offline-tool shape: `b2b`, `b2cs`, `hsn`) and CSV.

### 13. Reports
Tabs (Trial balance is owner / `pnl` only and shows a green "Debits equal credits" check):
- Project income & expenses
- Project profit & loss (`pnl` only), sorted by margin
- Spend by category: a pivot of categories against projects

Each tab has "Export this report (CSV)".

### 14. Payroll · October 2026
Tabs:
- **Monthly staff:**
  - Columns: gross, TDS, advance recovery, net.
  - Actions: "Process October payroll", then a Payslip button per row (the payslip modal prints).
- **Daily-wage labour:**
  - Columns: rate, days (with a +1 attendance button), earned, paid, balance.
  - "Pay wages" posts a Labour expense to the project.
- **Contractors:**
  - Columns: job value, paid, balance, progress.
  - "Pay" posts a Subcontract (FC) expense.

Add buttons per tab: + Add employee, + Add worker, + Add contract job.

### 15. Inventory · material purchases
Filter by project, category summary cards, table (item, category, project, vendor, quantity + unit, amount, average rate). Buttons: + Record purchase and Export CSV.

### 16. Users & security (owner only): **admin panel**
Tabs:
- **Users & access:** table of user (name + email), role, rights (Full access / Role default / **Custom rights** in amber), projects, mobile, last sign-in, status.
  - Row actions: **Edit rights**, Deactivate / Activate.
  - The owner row is fixed and shows "Always full access".
  - **+ Add user** opens the user drawer.
- **User drawer (660px):**
  - Fields: Name or role title, Work email, Mobile (contact only).
  - Role chips: Admin / Project manager / Site engineer. Changing the role resets rights to that role's template.
  - Project access: All projects, or Selected projects only (multi-select chips).
  - **Rights by module:** 14 rows, each a segmented control (None / View / Edit / Full, limited per module). Shows a "Custom" badge and "Reset to role defaults" when edited.
  - Validation: name required; valid, unique email; 10-digit mobile; at least one project when scoped.
- **Role templates:** a read-only matrix of the defaults.
- **Security:**
  - Books lock date editor ("Update lock").
  - Security policy rows.
  - Reset demo data (prototype only; remove in production).
- **Audit trail:** when / who / what changed, newest first. Every create, edit, delete, approval, payment, sign-in and rights change writes a row.

### 17. Site engineer: mobile layout
Max-width 430px, touch targets ≥ 44px.
- **Home:**
  - "+ Add site expense" button (56px).
  - Assigned sites list.
  - "Your entries" with Pending / Approved / Rejected pills.
- **Add expense form:**
  - Site, amount (56px, 24px/600), what it was for, category chips, paid-by mode.
  - Paid to and date.
  - **Take photo of bill (required):** uses `capture="environment"`.
  - Sticky "Submit for approval" button.
- **Production:** build it as a PWA with an offline draft queue, and send an idempotency key with each submission.

---

### 18. Support (customer service desk, Zoho Desk–style, internal only)
Nav group **Support**. Rights modules: \`tickets\`, \`warranty\`, \`kb\`. Default handlers: **Owner** and **Asst. Manager · Project Management** (\`tickets = full\`). The Project Manager and Admin have view only. Site Engineers have no desktop access; they see only the visits assigned to them, on mobile.

**Tickets** (\`TKT-####\`, never deleted)
- **Types:** Snag / defect, Warranty claim, Service & repair, AMC visit, Billing query, Change request.
- **Channel:** staff log every ticket by hand. The "Received via" label is Phone call, Walk-in, WhatsApp, Email or Site visit.
- **Statuses:** Open → In progress → Awaiting client / Visit scheduled → Resolved → Closed.
  - Reopening a resolved or closed ticket clears its resolved time and rating.
  - A ticket can't be resolved or closed while a visit is still Scheduled.
- **SLA** (calendar hours from \`created\`):

  | Priority | First response | Resolution |
  |---|---|---|
  | Urgent | 1h | 4h |
  | High | 4h | 24h |
  | Normal | 8h | 3 days |
  | Low | 24h | 7 days |

  - The first **Reply to client** or **Call log** entry stamps \`firstResp\`. Internal notes don't.
  - The SLA cell shows "Due in …" (amber when 25% or less of the target is left), "Overdue by …", "Responded in …" or "Missed · took …".
  - Notifications fire for breached tickets and tickets due soon.
- **Queue:**
  - Cards: Open, SLA breached, Visits scheduled, Awaiting client.
  - View chips with counts: Open / Assigned to me / SLA breached / Unassigned / Resolved / Closed / All.
  - Sort order: breached first, then priority, then oldest.
  - Columns: Ticket, Subject · project, Type, Priority, Status, SLA, Assigned to.
- **Detail page** (main column + 320px side column):
  - **Main column:**
    - Reported issue, with a coverage chip.
    - Activity thread: system events, Reply to client, Call log, Internal note (amber).
    - Composer: kind chips, **Insert template** (placeholders \`{client} {ticket} {project} {engineer} {date}\` filled from the ticket), **Insert care guide**, textarea and post button.
  - **Side column:**
    - Properties: status, priority and assignee chips.
    - SLA card.
    - Client & site card, with warranty status and AMC.
    - Site visits.
    - Billing.
    - Customer rating.
- **Coverage**, decided when the ticket is created from \`project.handover\`, \`wMonths\` and \`amcUntil\`:
  - Snag, warranty claim or service, within warranty → **In warranty**.
  - The same after the warranty end → **chargeable**.
  - Project not yet handed over → fixed under the contract.
  - AMC visit → covered while the AMC is active, otherwise chargeable.
  - Change request → chargeable.
  - Billing query → not applicable.
- **Billing:** a chargeable ticket shows **Create quotation** (quote linked by \`tkId\`) and **Raise tax invoice** (invoice linked by \`tkId\`).
  - Accepting a service quotation links it to the ticket's project. It does not create a new project.
- **Site visits:** Schedule visit (date, slot Morning / Afternoon / Evening, site engineer, instructions). The ticket status becomes "Visit scheduled". Scheduled visits can be cancelled.
- **Mobile, site engineer:**
  - Home lists "Service visits": today in teal, overdue in red.
  - The visit screen shows the job, a Call button (\`tel:\`), and **before photos (required)** and **after photos (required)**. Photos come from the camera or gallery, multiple at once, and are downscaled to 1000px JPEG.
  - It also has "What was done" (required) and an optional cost: category, mode, and a bill photo (required if a cost is entered).
  - **Completing the visit:**
    - The visit is set to Completed.
    - The ticket goes to In progress.
    - The thread gets a system entry and a "Work done" note.
    - If a cost was entered, an expense (\`tkId\` set, \`status = pending\`, \`by = Site Engineer\`) is charged to the project and goes to the owner's approval queue.
- **Rating:** after Resolved or Closed, staff record 1–5 stars and a comment from the closing call.
- **Dashboard tab:**
  - Cards: average first response, average resolution, response SLA met %, resolution SLA met %, customer rating, service cost charged to projects (approved, with pending shown separately).
  - Charts: tickets by type, by status, by project.
  - Team workload table: open, resolved, breached, average rating.
  - SLA targets table.
- **Site visits tab:** every visit, scheduled first.

**Warranty register:** one row per project.
- Columns: handover, warranty end and days left, status (In warranty / Expiring soon ≤60 days / Warranty expired / Not handed over), AMC, open / total tickets, approved repair cost.
- Clicking a row (\`warranty ≥ edit\`) opens a form: handover date (not in the future, not before the project start), period (6 months / 1 / 2 / 5 years) and AMC valid till.
- Recording a handover marks the project Completed.

**Knowledge base:**
- **Care guides tab:** list plus reader. Categories: Care guide, Warranty, How-to, Checklist.
- **Reply templates tab:** cards.
- \`kb ≥ edit\` can create and edit. \`kb = full\` can delete.

---

## Interactions & behaviour
- **Permissions:** `can(module, level)`, with levels none < view < edit < full; the owner always passes. It drives:
  - which nav items appear;
  - which buttons show;
  - which row actions show;
  - the "no access" empty state.

  The full matrix and rules are in **Technical Spec §5**. Enforce them on the server.
- **Project scope:** a user with selected projects sees only those projects and their invoices, receipts (+pfId), expenses, bills, labour, contracts, items, bank lines and reports.
- **Approval flow:** an expense saved by a non-approver is `pending`. It is excluded from balances, banking, reports and GST until approved. Editing an approved expense without the approve right sends it back to `pending`.
- **Lock date:** blocks every create/edit/delete dated on or before it. Error text: "Books are locked till 30 Sep 2026. Pick a later date."
- **Budget alerts:** at ≥85% (amber) and >100% (red) of the cost budget. They appear on the dashboard, in notifications and on the project page.
- **GST split:** client state code vs company state code 33 → CGST+SGST or IGST at 18%. SAC defaults to 9954.
- **P&L definition:**
  - Revenue = invoiced taxable value (excluding GST, excluding cancelled invoices).
  - Cost = approved expenses + unpaid vendor bills.
  - Margin = profit ÷ revenue.
- **Credit notes:** a credit note in the same month as its invoice removes the invoice from GSTR-1. One in a later month reduces that later month's output tax (CDNR).
- **Numbering:** gapless series per financial year. The prototype uses max+1; production must use a locked `number_series` row inside the insert transaction.
- **Search:** at 2 or more characters, searches project code/name/client, invoice no/client, bill no/vendor, and expense particulars/vendor. Escape closes it.
- **Notifications:** each item has a stable key; read state is kept per user.
- **Formatting:** ₹ with en-IN grouping (₹1,00,000). Large KPIs as ₹x.xx L or ₹x.xx Cr. Dates as "14 Oct 2026". Financial year runs April–March.
- **Empty states:** dashed `#C9D3DF` border, centred 13.5px `#5B6573` text.
- **Errors:** inline at the bottom of forms: background `#FEF3F2`, text `#B42318`, radius 6px.
- **Print:** elements marked `data-noprint` are hidden when printing (invoice and payslip).

## State (move all of it to the server)
`tickets (+thread[], visits[{before[],after[],work,cost,eng}], rating, firstResp, resolvedAt, chargeable), canned, kb, projects (+handover, wMonths, amcUntil), expenses (+tkId), quotes/invoices (+tkId), clients, vendors, quotes (+rev, history[], pid), proformas (+status, convInv, convDate, quoteId), pos (+status), projects (+quoteId), invoices (+quoteId, pfId (+cancelled, cnNo, cnDate), receipts, expenses (+status, billId, conId, billUrl), bills (+paid), users (+perms{module:level}, projects 'All'|[ids], active), staff, daily (workers), contractors, items, payrollRun, recon{txKey:bool}, lockDate, audit[]`.
UI-only state: current screen, project, invoice and tab; filters; drawer form state; search query; notification open/read state; toast.

## Design tokens
**Colours**
- Primary `#1F5FAE` · hover `#184E91` · tint `#E8F0FA` / `#F0F6FD` / `#F5F9FE` · deep heading `#0F2A4A`
- Ink `#1B2430` · body `#344054` · muted `#5B6573` · subtle `#8A94A6` · disabled `#98A2B3`
- Lines: `#E3E7ED` (card border), `#EEF1F5` (row divider), `#D5DBE3` (input border), `#C9D3DF` (dashed)
- Surfaces: app background `#F4F6F9`, card `#FFFFFF`, table header `#F8FAFC`, chip track `#F1F4F8`
- Success `#1E7A4C` on `#E3F4EA` · Warning `#8A5A00` / `#B7791F` on `#FCF1DC` / `#FFF8EB` · Danger `#B42318` on `#FDECEA` / `#FEF3F2`
- Category palette: Material `#1F5FAE`, Labour `#14A39A`, Subcontract `#7FA7DC`, Transport `#E0A43A`, Fuel `#D9653B`, Misc `#98A2B3`, Incentives `#8B6FD1`, Site visit `#3FB68B`, Rent/Equipment `#4D5B70`
- Ageing: `#14A39A`, `#7FA7DC`, `#E0A43A`, `#D9653B`, `#B42318`

**Typography**
- Fonts: IBM Plex Sans (400/500/600/700) for UI; IBM Plex Mono (400/500) for IDs, document numbers and GSTINs.
- Sizes: H1 22/600 · section title 15/600 · body 13–13.5 · small 12–12.5 · table header 11/600 uppercase · KPI 24/600 · stat 18/600 · invoice title 22/700.

**Spacing, radius, shadow**
- Spacing: 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 28 px. Page gap 16–20px. Card padding 16px.
- Radius: inputs/buttons 6px · cards 8px · mobile cards 10px · pills 11px (22px tall) · chips 15px.
- Shadows: dropdown `0 12px 32px rgba(16,24,40,.14)` · drawer `-12px 0 32px rgba(16,24,40,.18)` · dialog `0 16px 48px rgba(16,24,40,.25)`.
- Controls: buttons 34px (forms 36px), table row actions 26px, inputs 36px (mobile 48–56px).

## Assets
- `assets/cityscape-logo.png`: the client's logo, used in the header, login, invoice and payslip.
- Bell icon: inline SVG (lucide-style "bell"); use your icon library's equivalent.
- No other imagery. Bill photos are user uploads; in production, store them in private object storage behind pre-signed URLs, stripping EXIF GPS data.

## Files in this bundle
- `START HERE – Claude Code.md`: build brief, stack, phases and the first prompt to give Claude Code.
- `Cityscape Books - Requirements.dc.html`: the requirements document (FR IDs, acceptance criteria, UAT scenarios, 38 screenshots). Export it to PDF from the browser if needed.
- `Cityscape Books.dc.html`: the full clickable prototype (all screens, logic, permissions engine; see the `class Component` logic block). Open it in a browser served from this folder.
- `cityscape-data.js`: seed data (project CSD-PRJ-0001 is transcribed from the client's Hire Nexa payment sheet).
- `Technical Spec.md`: backend specification (architecture, journals, schema, API, security, GST, support module, migration).
- `docs/screens/`: screenshots used in the requirements document.
- `assets/cityscape-logo.png`, `support.js`, `doc-page.js`: needed to open the HTML files locally.

## Still needed from the client before go-live
Registered address, GSTIN, phone and bank details (placeholders are on the invoice) · invoice terms text · staff master and salaries · opening balances as on 1 Apr 2026.
