# Cityscape Books — Engineering Standards

This file applies the *Internal SaaS Software Development Standards* handbook to this project.
Every handbook rule is mapped to a concrete control here, with the place where it is enforced and how it is verified.
When this file and `SPEC-FIXES-v1.4.md` disagree, **this file wins**. Section 0 lists the decisions it changed.

**Non-negotiable:** no production release happens without a human code review, green CI, a verified backup taken within the last 24 h, and a written rollback step (handbook §1, §9).

---

## 0. Decisions changed by the handbook

| # | Earlier decision | Handbook rule | New decision | Status |
|---|---|---|---|---|
| H1 | Email + password only, no MFA (client asked for "no SMS/OTP") | §1.2: MFA for privileged accounts | **Passkeys (WebAuthn)** are mandatory for Owner and Admin, and optional for everyone else. No SMS and no typed codes, so the client's "no OTP" wish still holds. Each privileged user registers 2 passkeys (phone + laptop). Recovery codes are printed once and kept in the office safe. | **CONFIRM with owner** |
| H2 | C1: payroll, wage, contractor and vendor payments post without approval | §7.4: supplier payments and salary changes need authorisation limits | **Threshold approvals.** Vendor payments and contractor payments ≥ ₹25,000, any change to an employee's salary or daily rate, and quotation discounts > 10% all need Owner approval. Daily wages below the threshold post directly and appear in the daily "Posted without approval" digest. Thresholds are set in Settings, and every change to them is audited. | **CONFIRM amounts** |
| H3 | No auditor role | §7.2: Auditor = read-only | New role **`auditor`** (the company's CA). View on every finance module, including `pnl` and the audit log. No edit rights anywhere. Access has an expiry date. | FIXED |
| H4 | Audit log covers writes | §7.3: sensitive exports | Every CSV/XLSX/PDF export, GSTR-1 JSON download, payslip view and bill-photo view also writes an audit row. | FIXED |
| H5 | Dev environment only | §1.1, §8: dev / staging / production | Three environments, each with its own database, bucket and secrets. Production data is never copied down; staging uses synthetic seed data. | FIXED |

---

## 1. Version control (handbook §1.1)

| Rule | Control |
|---|---|
| Git, hosted | GitHub repository (private), owned by a Cityscape Decors company account, **not** a developer's personal account (§13.2). |
| Branches | `main` = production-ready. Short-lived `feature/<FR-id>-slug`, `fix/<issue>-slug`, `hotfix/<slug>`. No `develop` branch (the team is small). |
| Protection | `main` is protected: a PR is required, ≥ 1 human approval, all CI checks green, linear history, no force-push, no direct commits — admins included. |
| Traceability | Each PR title starts with its requirement or defect ID (`FR-3.3.1`, `BUG-012`). Commits follow Conventional Commits. Each release is tagged `vX.Y.Z` (SemVer). |
| Secrets | Never in the repo. `.env*` is git-ignored, except `.env.example`. CI runs **gitleaks** on every PR. |
| Config | Environment-specific values come only from environment variables, which are validated at boot by a typed schema (zod). The app refuses to start if one is missing. |

## 2. Security by design (handbook §1.2, §7.1, §7.5; OWASP ASVS L2)

| Area | Control | Verified by |
|---|---|---|
| Passwords | argon2id (m=64 MB, t=3, p=1), min 12 chars, checked against HIBP k-anonymity | unit test |
| MFA | Passkeys for Owner and Admin (H1) | e2e |
| Sessions | 15-min access JWT, rotating refresh token in an httpOnly / Secure / SameSite=Strict cookie, 30-min idle timeout, all sessions revoked on password or role change | integration |
| Lockout and rate limits | 5 failures → 15-min lock + owner notified; login 10/min per IP; API 300/min per user | integration |
| Authorisation | One `can(user, module, level, projectId?)` in `packages/core`. Every route handler is wrapped in `withAuth(module, level)`, and a **lint rule fails the build** if a route is exported without it | unit + permission-matrix e2e |
| Company isolation | `company_id` is taken from the session and **never** from the request body. Postgres RLS is enforced via `SET LOCAL app.company_id` in every transaction. Background jobs carry `company_id` in the job payload and set it the same way | security test: a cross-company read must return 404 |
| Field-level | Serializer strips `profit`, `margin` and `net` when `pnl = none` | API test |
| Input | zod schemas on every endpoint; Drizzle parameterised queries only; raw SQL is banned by a lint rule except in `packages/db/sql/` with review | lint + tests |
| Files | MIME sniffing, 10 MB cap, re-encoded with sharp, EXIF stripped, private bucket, 5-min pre-signed GET URLs | integration |
| Transport and headers | TLS 1.2+, HSTS, strict CSP (nonce), `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` | automated header check in CI |
| Logging | pino structured logs with redaction of `password`, `token`, `authorization`, `cookie`, `pan`, `bank_acc`, `phone` | unit test on the redactor |
| Dependencies | Renovate (weekly), `npm audit` + OSV scanner in CI, which fails on high or critical; licence allow-list (MIT, Apache-2.0, BSD, ISC) | CI |
| Access lifecycle | Joiner: owner invites → role template → least privilege. Mover: a role change resets rights to the template and revokes sessions. Leaver: deactivate revokes sessions instantly. **Quarterly access review**: the owner gets an in-app task listing every user and their rights to confirm | audit log |

## 3. Testing and QA (handbook §2)

| Layer | Tool | Scope | Gate |
|---|---|---|---|
| Unit | Vitest | `packages/core`: money, GST, rounding, numbering, journal posting, `can()`, SLA, coverage | ≥ 90% line coverage on `packages/core` |
| Integration | Vitest + Testcontainers (real Postgres 16) | Each API route: happy path, 403, 422, 423 lock, idempotent replay | every route |
| End-to-end | Playwright | The 12 UAT scenarios from Requirements §10, one spec file each | all green |
| Regression | Vitest/Playwright | Every fixed bug gets a test named `BUG-###` before the fix merges | enforced in PR checklist |
| Security | Permission-matrix test (every module × level × role), cross-company tests, OWASP ZAP baseline scan on staging | CI (ZAP nightly) |
| Performance | k6 on staging: lists ≤ 500 rows p95 < 300 ms; 5,000-row ledger < 1 s | before every minor release |
| UAT | Owner + Admin on staging, using the UAT checklist | business sign-off recorded in the release |

**Test data:** synthetic seed only (from `cityscape-data.js`, anonymised). No production personal data outside production.

**Definition of Done** — a PR merges only when:
1. The FR acceptance criteria are met and linked in the PR.
2. Unit + integration tests are added and green; there is an e2e test if a user journey changed.
3. The permission and project-scope cases are tested.
4. Migration added, if the schema changed (see §4).
5. Docs updated: API contract (OpenAPI), CHANGELOG, runbook if operations changed.
6. Reviewed and approved by a human.

## 4. Database and data integrity (handbook §3, §7.6)

- **Migrations:** Drizzle-generated SQL, committed and reviewed. CI applies them to an empty database **and** to a staging snapshot. Migrations are forward-only, with an *expand → migrate → contract* pattern: never drop or rename a column in the same release that stops using it.
- **Constraints in the DB, not just the app:** FKs everywhere, CHECKs on enums and amounts ≥ 0, a deferred constraint trigger for the balanced journal, `UNIQUE(company_id, fy, number)` per series, `UNIQUE(client_entry_id)` for idempotency.
- **Immutability:** posted journals are never updated; corrections are reversing entries. `audit_log` uses an INSERT-only DB role, with UPDATE and DELETE revoked.
- **Deletes:** invoices, tickets and journals are never deleted. Masters are soft-deleted (`deleted_at`). Drafts can be hard-deleted.
- **Duplicates (§7.6):** `Idempotency-Key` on every POST, stored 24 h. A double-click on "Pay" returns the first result.
- **Transactions:** each business command (e.g. "convert proforma") is one DB transaction: number allocation + document + journal + audit row.

### Backup and recovery (handbook §3.3, §10.4)

| Item | Target |
|---|---|
| **RPO** | **15 minutes** (continuous WAL archiving / managed PITR) |
| **RTO** | **4 hours** for a full region outage; **1 hour** for an accidental delete (PITR restore to a side database, then copy rows back) |
| Schedule | Managed PITR (35 days) + nightly logical dump (`pg_dump`, encrypted with age) to a **separate cloud account**, kept 90 days, plus monthly dumps kept 8 years (statutory books retention) |
| Bucket | Versioning on, cross-region replica, 30-day delete-protection |
| Restore drill | **Quarterly**: restore into staging, run the trial-balance check and row counts, then record the time taken in `docs/RUNBOOKS.md` |
| Owner | IT/Ops owner (see §8). Backup failures alert within 1 h. |

## 5. Architecture and code (handbook §4)

**Modular monolith.** One Next.js deployable plus one worker. Modules live in `packages/core/src/<module>/` (`auth`, `contacts`, `projects`, `sales`, `purchases`, `expenses`, `ledger`, `gst`, `banking`, `payroll`, `inventory`, `support`, `reports`, `admin`). A module exposes a public `index.ts`; importing another module's internals is blocked by an ESLint boundary rule. No microservices.

```
apps/web        UI (React Server Components + client components), /api/v1 handlers (thin), /m PWA
apps/worker     BullMQ jobs (PDF, exports, digests, SLA notifications)
packages/core   business rules only: no HTTP, no React
packages/db     schema, migrations, RLS policies, seed
packages/ui     design-token components
```

**Code standards:** TypeScript `strict`, ESLint + Prettier (CI-enforced), max function complexity 10, no `any` without a comment, no business rules in UI or route files, money as integer paise in code (`bigint`), converted to `NUMERIC(14,2)` in the DB. Errors use one shape `{code, message, field?}`, with HTTP 403/404/409/422/423 used consistently. Non-obvious decisions are recorded as ADRs in `docs/adr/`.

## 6. Release process (handbook §6, §9)

1. PR → CI: typecheck, lint, unit, integration, build, gitleaks, audit, licence check.
2. Merge to `main` → auto-deploy to **staging** → migrations → e2e suite → ZAP baseline.
3. UAT on staging (for features), with sign-off recorded in the release issue.
4. Release: tag `vX.Y.Z`, CHANGELOG entry, **pre-deploy backup snapshot**, deploy to **production** with manual approval in a GitHub Environment (Technical Lead), then smoke tests.
5. Rollback: redeploy the previous image tag. Expand/contract migrations mean the old code still runs on the new schema. If data is damaged, follow the PITR runbook.
6. A critical failure stops the release unless the Product Owner accepts the risk in writing on the release issue.

Release windows: weekdays, never on the 18th–20th of the month (GST filing) or the last 2 days of the month (payroll).

## 7. Monitoring and operations (handbook §10)

| Signal | Tool | Alert |
|---|---|---|
| Errors | Sentry (with PII scrubbing) | new issue or error rate > 1% for 5 min |
| Uptime | external probe of `/api/health` (DB + bucket + queue) | 2 failures in a row |
| Latency | p95 per route (OpenTelemetry) | p95 > 800 ms for 10 min |
| Jobs | BullMQ failed-job count | any failed PDF/export after 3 retries |
| Backups | backup-job heartbeat | missed nightly dump |
| Security | lockouts, permission-denied spikes, new device sign-in for owner | in-app + email to owner |
| Books | nightly trial-balance check per company | debits ≠ credits → page Technical Lead |

The incident process (severity S1–S4, owner, contain → restore → RCA within 5 working days) is in `docs/RUNBOOKS.md`.

## 8. Ownership (handbook §13) — names needed

| Role | Person | Duties here |
|---|---|---|
| Product owner | Saravanan S (Owner) | priorities, UAT sign-off, risk acceptance |
| Business process owner | Saravanan S | approval thresholds, rights, lock date |
| Technical lead / reviewer | **TBD (human)** | approves every PR and production deploy |
| Developer | Claude Code + TBD | implementation, tests, docs |
| QA / tester | Accounts Admin (UAT) + automated suites | test plans, regressions |
| IT / operations owner | **TBD** | hosting, backups, restore drills, incidents |

**AI-assisted development (handbook §13.2):** Claude Code opens PRs; it does not merge them. A named human reviews every PR, and **auth, permissions, posting, numbering and GST code needs line-by-line review**. No secrets or real client data are given to AI tools. The repository and cloud accounts belong to Cityscape Decors.

## 9. Privacy and legal — India (handbook §11)

**Personal data held:** staff (name, phone, email, PAN, bank account, salary, attendance), individual clients (name, phone, address), callers on tickets, photos (bill and site; EXIF GPS stripped).

| DPDP Act 2023 duty | Control |
|---|---|
| Purpose and notice | A short privacy notice is shown to staff at first sign-in and given to clients with the quotation T&Cs |
| Minimisation | No Aadhaar stored. PAN and bank details only for payroll and vendors, masked in the UI (last 4 digits) except for the payroll right |
| Access | Rights + project scope (§2). Every view of PAN, bank details or salary is audited |
| Retention | Books, invoices, GST records: **8 years** (Companies Act s.128 / CGST s.36, the longer of the two). Payroll records: 8 years. Ticket caller details: 3 years after closure, then anonymised. Ex-staff login: deactivated on exit; data kept for the statutory period |
| Correction and erasure | The owner can correct masters. Erasure requests are honoured except where statutory retention applies, and the reason is logged |
| Breach | The incident runbook includes notifying the Data Protection Board and affected people as the DPDP Rules require. **Have counsel confirm timelines.** |
| Processors | Hosting, email and error-tracking vendors are listed in `docs/RUNBOOKS.md` with their DPA links; India-region hosting |

**IP:** a work-for-hire / IP assignment clause in every developer contract; the licence allow-list in CI; logo and fonts licensed (IBM Plex = OFL).

*This is engineering guidance, not legal advice.*
