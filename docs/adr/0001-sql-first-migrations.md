# ADR 0001 — SQL-first migrations; integer paise as safe numbers

**Status:** accepted · 16 Oct 2026

## Context
The guard-rails that must never break (balanced journal, immutable journal and audit log, lock date,
gapless numbering, company isolation) live in PostgreSQL: deferred constraint triggers, RLS
policies, SECURITY DEFINER functions and custom SQLSTATEs. ORM schema generators do not express
these well.

## Decision
1. Migrations are hand-written, reviewed SQL files in `packages/db/migrations/NNNN_name.sql`,
   applied in order by `packages/db/src/migrate.ts`, one transaction per file, and recorded in
   `schema_migrations`. They are forward-only and use expand → contract.
2. A typed query layer (Drizzle) may be added on top for CRUD queries, but it never generates
   or alters the schema.
3. Money in TypeScript is **integer paise held in a JS number**, asserted with
   `Number.isSafeInteger` and the NUMERIC(14,2) range. The ENGINEERING-STANDARDS draft said
   `bigint`. Safe integers cover ±₹90 trillion, serialise to JSON without custom code, and
   rule out floats just the same.
4. Custom SQLSTATEs: `CB422` unbalanced journal, `CB423` period locked, `CB409` append-only.
   `mapDbError` turns them into HTTP 422 / 423 / 409.

## Consequences
- Every schema change is visible SQL in review. No hidden diff from a generator.
- Integration tests run the real migrations, as a non-superuser owner, on Postgres 16 in CI.
- An unreleased migration may be edited. Once a migration reaches staging, it is never edited again.
