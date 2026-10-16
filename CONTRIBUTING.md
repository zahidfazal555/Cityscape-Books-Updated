# Contributing to Cityscape Books

Read `docs/ENGINEERING-STANDARDS.md` first. This file is the short version.

## Branches
- `main` is protected and always deployable.
- Work on `feature/<FR-id>-short-name`, `fix/<BUG-id>-short-name` or `hotfix/<short-name>`, and keep branches short-lived (≤ 3 days).

## Commits
Conventional Commits: `feat(sales): convert proforma to tax invoice (FR-4.3.5)`, `fix(gst): IGST for inter-state bills (BUG-004)`.

## Pull requests
- One concern per PR, ideally < 400 changed lines.
- The title starts with the FR or BUG ID.
- Fill in the PR template checklist. An independent review session (`/code-review high`, `max` for sensitive code) must pass before merge. Production deploys need the human Release Approver.
- Code in `packages/core/src/{auth,admin,ledger,gst}` and any migration needs line-by-line review.

## Definition of Done
1. Acceptance criteria met (linked FR).
2. Unit + integration tests added and green; e2e test if a user journey changed.
3. Permission and project-scope cases tested (403 / 404).
4. Migration added if the schema changed (expand → contract, never destructive in the same release).
5. OpenAPI, CHANGELOG and runbooks updated where relevant.
6. Independent review passed, CI green.

## Never
- Commit secrets, `.env` files or real client/staff data.
- Change production by hand. Every change goes through a migration or a release.
- Put business rules in UI components or route handlers; they belong in `packages/core`.
- Trust `company_id`, `user_id` or role values sent by the browser.
