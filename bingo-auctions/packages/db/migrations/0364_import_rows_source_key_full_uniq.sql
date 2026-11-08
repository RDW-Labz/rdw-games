-- 0364 — the untracked-import ON CONFLICT names a PARTIAL index, so it can't fire.
--
-- Jared's manifest import fails with
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
-- for every untracked row.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- 0310 built import_rows_source_key_uniq as a PARTIAL unique index:
--   UNIQUE (operator_id, source_key) WHERE source_key IS NOT NULL
--
-- Both callers upsert through PostgREST with `on_conflict=operator_id,source_key`
-- and NO predicate:
--   • apps/operator-web/src/app/(operator)/imports/actions.ts  (the wizard, #337)
--   • scripts/import-d2l-manifest.mjs:350                       (the daily feed)
--
-- PostgREST's on_conflict= emits only the column list. Postgres will not infer a
-- PARTIAL index for ON CONFLICT unless the statement repeats the index's WHERE
-- clause — which PostgREST cannot express. So neither path can match the index,
-- and any batch containing untracked (source_key IS NOT NULL, tracking NULL)
-- rows errors. Tracked rows were never affected: import_rows_tracking_uniq
-- (mig 0153) is a FULL index, so `on_conflict=operator_id,tracking_number`
-- matches it.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────────
-- Replace the partial index with a FULL one on the same columns. A predicate-
-- less ON CONFLICT can then match it. Enforcement is unchanged in practice:
--   • non-null source_key: still exactly one row per (operator_id, source_key);
--   • null source_key (tracked rows): NULLs are DISTINCT in a btree (PG17
--     default, and we do NOT pass NULLS NOT DISTINCT), so the 233,800 tracked
--     rows with source_key IS NULL remain unconstrained — same as the partial.
--
-- ── CAN THIS FAIL ON EXISTING DATA? ──────────────────────────────────────────
-- No. Non-null (operator_id, source_key) duplicates cannot exist: the partial
-- index has been enforcing that uniqueness since 0310, so there is nothing for
-- the full build to trip over. The null-source_key rows do not collide (NULLs
-- distinct). Verified shape on prod 2026-09-21: import_rows_source_key_uniq is
-- present and partial; import_rows_tracking_uniq is present and full.
--
-- DROP + CREATE run inside the migration's single transaction, so if the CREATE
-- somehow failed the DROP rolls back and the partial index is left in place —
-- the schema can never end up with no index on this column.
--
-- ── LOCKING ──────────────────────────────────────────────────────────────────
-- Not CONCURRENTLY — apply-migrations wraps the file in one transaction, where
-- CONCURRENTLY is illegal (SQLSTATE 25001), and we want the drop+create atomic
-- regardless. The build takes SHARE on import_rows and blocks writes to that
-- table for its duration (252k rows / ~405 MB → seconds to low minutes).
-- Imports are already failing, so this is the "fix now" case: the lock window
-- is strictly better than the current state, where every untracked import 500s.
-- It does NOT touch lots/bids/checkout — only import_rows writes wait.

DROP INDEX IF EXISTS public.import_rows_source_key_uniq;

CREATE UNIQUE INDEX import_rows_source_key_uniq
  ON public.import_rows (operator_id, source_key);

ANALYZE public.import_rows;
