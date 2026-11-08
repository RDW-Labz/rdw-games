# Archived: supabase/migrations/

This directory is **not the canonical migration source**. It has been archived and is kept
only for historical reference.

## Why archived

The Supabase CLI expects migrations in `supabase/migrations/` by convention, but this
project chose to keep the authoritative SQL in `packages/db/migrations/` instead, so
that the `@auction-platform/db` package owns the full migration history as a proper
workspace package.

The 12 files here (0001–0012) were an early copy of the first 12 migrations and were
never updated beyond that point. `packages/db/migrations/` continued to grow to 26+
files and is what CI, `scripts/push-hosted-migrations.js`, and local dev actually use.

## Canonical location

`packages/db/migrations/` — 26 files, 0001_init.sql through 0035_stripe_skip_flag.sql
(and growing). Do not add migrations here.

## Divergence evidence

- `diff -r supabase/migrations.archived packages/db/migrations` shows 0001–0012 are
  byte-for-byte identical, and 0013–0026+ exist only in `packages/db/migrations/`.
- `git log -- supabase/migrations/` shows a single commit touching these files.
- `git log -- packages/db/migrations/` shows ongoing active commits.
- `.github/workflows/ci.yml` applies `packages/db/migrations/*.sql` directly.
- `scripts/push-hosted-migrations.js` hard-codes `packages/db/migrations` as the source.
