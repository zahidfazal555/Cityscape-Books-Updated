# Cityscape Books — notes for Claude Code

Read `docs/ENGINEERING-STANDARDS.md` before changing anything. Precedence: ENGINEERING-STANDARDS → SPEC-FIXES-v1.4 → Requirements v1.3 (`docs/handoff/`) → Technical Spec → handoff README → prototype.

## Layout
- `packages/core` — pure business rules (money, GST, GSTIN, dates/FY, lock date, permissions, numbering). Must not import pg/next/react/@csd/db (lint-enforced).
- `packages/db` — SQL migrations (`migrations/`), tenant transactions (`withTenant`), numbering, journal posting, audit.
- `apps/web` — Next.js app (not yet created).

## Commands
- `pnpm check` — typecheck, lint, format check, all tests.
- DB tests need a Postgres 16 superuser URL in `TEST_ADMIN_URL` (default `postgres://postgres:postgres@localhost:5432/postgres`). In a cloud session: `service postgresql start`.

## Rules that must never break
- Every DB access for a tenant goes through `withTenant(pool, {companyId, userId}, fn)`. `companyId` comes from the session, never from the request.
- Every handler calls `authorize(actor, module, level, projectId)` from `@csd/core`.
- Numbers come from `allocateNumber` inside the document's transaction.
- Journals only via `postJournal` / `reverseJournal`. Never UPDATE or DELETE journals or audit rows.
- Non-approvers' entries are saved Pending (`requiresApproval`) and post no journal.
- Money is integer paise (`Paise`); never float rupees.
- Feature branches + PR; an independent `/code-review` pass before merge.
