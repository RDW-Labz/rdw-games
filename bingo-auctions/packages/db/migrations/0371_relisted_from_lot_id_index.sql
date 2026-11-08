-- 0371 — the relist-lineage walk reads all of `lots` for every public lot page.
--
-- (Drafted as 0364 in #348; renumbered to 0371 on 2026-09-23 because 0364-0370
-- were taken while it waited.)
--
-- ── THE QUERY ───────────────────────────────────────────────────────────────
-- loadSuccessorChain (apps/operator-web/src/lib/lot-lineage.ts) runs
--
--     SELECT ... FROM lots WHERE relisted_from_lot_id = $1
--
-- in a loop, so every public lot page view costs at least one. Measured on
-- prod before #348: 292,771 calls, 20.0 ms mean, 29,339 tuples read each — a
-- sequential scan of the whole table.
--
-- ── WHY THE EXISTING INDEX DOES NOT HELP ────────────────────────────────────
-- lots_one_active_relist_child is on this column but is partial on
-- `deleted_at IS NULL AND sticker_code IS NULL AND status IN (draft, scheduled,
-- live)`. The walk implies none of that — it exists to find RETIRED children —
-- so the planner cannot use it. This index is partial on NOT NULL only:
-- 5,093 of 31,941 rows on 2026-09-23.
--
-- ── LOCKING ─────────────────────────────────────────────────────────────────
-- Not CONCURRENTLY: apply-migrations.js wraps the file in a transaction, and
-- CONCURRENTLY fails there with SQLSTATE 25001. A plain CREATE INDEX takes
-- SHARE on `lots`, which blocks writes — bids included — for the build.
-- Expected well under a second at 5k rows, but apply after the 18:00 close
-- (CLAUDE.md Rule 9).
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS public.lots_relisted_from_lot_id_idx;
-- No data changes; the walk falls back to the sequential scan.

CREATE INDEX IF NOT EXISTS lots_relisted_from_lot_id_idx
  ON public.lots (relisted_from_lot_id)
  WHERE relisted_from_lot_id IS NOT NULL;
