# ADR 0013 — Single Idempotent `schema.sql` (No Migration Tool)

## Status

Accepted (2026-06-04); deploy-order lesson recorded 2026-06-06.

## Context

Legion owns one Postgres schema (`legion`) inside GunVest's database (ADR 0007). It is a small,
single-maintainer project that ships frequently as phases land. A full migration framework
(versioned up/down files, a migrations table, a runner) is real overhead, and the schema is
append-mostly. But schema changes still have to apply safely to a running database across
deploys.

## Decision

Keep the entire schema in one idempotent file,
[`src/db/schema.sql`](../../src/db/schema.sql), applied by
[`src/db/migrate.js`](../../src/db/migrate.js) (`npm run db:migrate`). Every statement is
idempotent: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`. Later phases extend earlier (stub) tables in place rather than
adding versioned migration files, and re-running the migration is always safe. New tables (e.g.
`agent_config`, `signal_votes`) and new columns are appended to the same file.

## Alternatives considered

- **node-pg-migrate / Flyway / Prisma Migrate** — versioned, reversible, but heavyweight for a
  one-schema, one-maintainer project; the idempotent single file gives safe re-apply without the
  machinery.
- **Per-phase migration files in a `migrations/` dir** — the Phase 5 plan assumed this, but it
  conflicts with the established single-file convention; the table was appended to `schema.sql`
  instead.

## Consequences

- Applying or re-applying the schema is one safe, idempotent command.
- No down-migrations: rollbacks are manual (acceptable; the schema is additive).
- **Deploy-order lesson:** because `docker compose run` does **not** rebuild the image, the
  deploy must `compose build` **before** `run --rm … db:migrate`, or the migration executes the
  *previous* image's `schema.sql` against code that expects the new columns (this caused a live
  `column "rho" does not exist`). The CI deploy now builds before migrating.
