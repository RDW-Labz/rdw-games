-- 0362 — every public lot page view sequentially scans the whole `lots` table.
--
-- ── THE INCIDENT ────────────────────────────────────────────────────────────
-- 2026-09-19, 19:12–20:09 Central: the site and both apps were unusable for
-- roughly 45 minutes during the evening close hour. Customers complained; we
-- found out from a person, not a page. Every pg_cron job slowed together, then
-- 37 of them failed outright with `connection failed` — Postgres had no
-- connection slots left. It recovered on its own when the close hour ended.
--
-- Measured, not theorised (pg_stat_statements, stats_reset 2026-09-08):
--
--   the public lot page's resolve-by-code query
--     calls      1,181,337
--     mean       95.56 ms
--     total      112,922 s   <- 31.4 CPU-hours, 7x the next heaviest query
--
--   pg_stat_user_tables, `lots`
--     seq_scan        1,618,149
--     seq_tup_read   41,999,270,824   <- ~25,955 tuples per scan == whole table
--
-- 42 billion tuples read by sequential scan. The table is 29,175 rows / 42 MB
-- and fits in shared_buffers (99.48% cache hit), so this is not an I/O problem
-- — it is pure CPU, burned once per lot page view.
--
-- Week over week, the 19:30–20:15 window:
--
--     Tue 09-15   1261 runs   0 failed   avg   36 ms   max  5.6 s
--     Wed 09-16   1262 runs   0 failed   avg   35 ms   max  4.9 s
--     Thu 09-17   1263 runs   0 failed   avg   38 ms   max  5.9 s
--     Fri 09-18   1263 runs   0 failed   avg   39 ms   max  5.8 s
--     Sat 09-19    865 runs  65 failed   avg 1625 ms   max   58 s
--
-- Nothing shipped on 09-19 (last deploy 09-18 15:54 CT, which rode through a
-- clean close hour that same evening). What changed is size and load: `lots`
-- grew 25,352 -> 29,084 rows (+15%) in a week while close-hour bid volume hit
-- 685, 3.4x the previous Saturday. Cost scales with rows x views, so the same
-- always-present full scan finally crossed the point where it saturates the
-- instance — and past saturation, latency is non-linear. Hence "fine for
-- months, then a cliff".
--
-- ── WHY THE SCAN HAPPENS ────────────────────────────────────────────────────
-- `lotCodeMatchFilters` (packages/shared/src/lots.ts) builds a PostgREST
-- `or=(…)` over six terms. Three are equalities backed by existing indexes
-- (lots_lot_code_unique, lots_sticker_code_unique_idx, lots_legacy_search_idx).
-- The other three are ILIKE:
--
--     lot_code.ilike.CODE            -- no wildcard, but ILIKE is not a btree op
--     legacy_lot_code.ilike.CODE     -- same
--     sticker_code.ilike.%:CODE      -- LEADING wildcard; unindexable outright
--
-- One unindexable branch of an OR forces a scan of the whole relation, so all
-- six terms get evaluated per row, 29,175 times, per page view.
--
-- The same expressions appear DB-side in 0304's resolvers — `upper(l.lot_code)`,
-- `upper(split_part(l.sticker_code, ':', 2))` — with no expression index to
-- match, so `_find_lot_by_scan`, `batch_intake_lot_to_bin` and the lineage
-- walks scan too. They are part of the same 1.6M scans.
--
-- ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
-- Makes every one of those lookups index-backed, without changing which rows
-- any of them return.
--
--   1. `sticker_raw_upper` — a STORED generated column holding the upper-cased
--      raw half of sticker_code. PostgREST cannot filter on an expression, so
--      the storefront and the staff scanner need a real column to point at.
--   2. Four indexes: one on the new column (for PostgREST) and three on the
--      exact expressions 0304's functions already write (for the RPCs).
--
-- Verified against prod before writing this, so the rewrite is known-safe:
--
--     sticker_code values with >1 colon ...... 0      (split_part(…,':',2) exact)
--     sticker_code with an empty raw half .... 0
--     distinct sticker prefixes .............. 1      (always 'BIN')
--     lot_code not already upper-cased ....... 0 / 29,175
--     legacy_lot_code not upper-cased ........ 0 / 4,678
--     sticker_code not upper-cased ........... 47 / 18,905   <- upper() required
--
-- Those 47 rows (`BIN:tea4841550`, `BIN:csXR8F6kWxG`, …) are why the sticker
-- half gets upper() rather than a plain equality like the other two columns.
--
-- ── LOCKING: WHY NOT CONCURRENTLY ───────────────────────────────────────────
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and BOTH
-- backends of scripts/apply-migrations.js put the whole file in one:
-- the `pg` path wraps it in explicit BEGIN/COMMIT (lines 317-319) and the
-- Management API path runs each /database/query call as one implicit
-- transaction (lines 321-323). CONCURRENTLY through `Apply DB Migration
-- (BinGo prod)` would fail with SQLSTATE 25001.
--
-- It would also buy nothing here: step 1 is an ALTER TABLE adding a STORED
-- generated column, which rewrites the heap under ACCESS EXCLUSIVE regardless.
-- The indexes cannot be built lock-free alongside a lock-taking rewrite.
--
-- So this migration takes one short exclusive lock on `lots`. At 29,175 rows /
-- 42 MB heap the rewrite plus four small btrees is expected to be low single-
-- digit seconds. APPLY IT AFTER THE WAREHOUSE CLOSES (6 PM Central, CLAUDE.md
-- Rule 9) — during the day it would block put-away and checkout writes, and
-- during the close hour it would block finalize_due_lots.
--
-- If a zero-lock apply is ever required instead, the only route is a direct
-- psql session (not this workflow), splitting the file: ALTER first, then each
-- index as its own CREATE INDEX CONCURRENTLY statement outside any transaction.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS lots_sticker_raw_upper_idx;
--   DROP INDEX IF EXISTS lots_lot_code_upper_idx;
--   DROP INDEX IF EXISTS lots_legacy_lot_code_upper_idx;
--   DROP INDEX IF EXISTS lots_sticker_raw_expr_idx;
--   ALTER TABLE public.lots DROP COLUMN IF EXISTS sticker_raw_upper;
-- The app change in packages/shared/src/lots.ts must be reverted first or
-- alongside — it reads sticker_raw_upper.
-- ============================================================================

-- ── 1. The column PostgREST can filter on ───────────────────────────────────
--
-- GENERATED ALWAYS … STORED, so it cannot drift from sticker_code and needs no
-- trigger and no backfill. Both split_part() and upper() are IMMUTABLE, which
-- a generated column requires.
--
-- NULL when sticker_code is NULL (10,270 rows today) and NULL rather than ''
-- when there is no colon, so a malformed sticker can never collide with a real
-- code. split_part returns '' for a missing field, hence the explicit nullif.
ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS sticker_raw_upper text
  GENERATED ALWAYS AS (nullif(upper(split_part(sticker_code, ':', 2)), '')) STORED;

COMMENT ON COLUMN public.lots.sticker_raw_upper IS
  '0362: upper-cased raw half of sticker_code (the part after the operator '
  'prefix) — the label physically stuck to the box. Generated/STORED so '
  'PostgREST can filter it with an indexed equality; replaces the '
  'sticker_code ILIKE %:CODE leading-wildcard scan that cost 31 CPU-hours '
  'over 11 days and took the site down on 2026-09-19.';

-- ── 2a. The index the storefront + scanner use (via PostgREST) ──────────────
CREATE INDEX IF NOT EXISTS lots_sticker_raw_upper_idx
  ON public.lots (sticker_raw_upper)
  WHERE sticker_raw_upper IS NOT NULL;

-- ── 2b. Expression indexes for the DB-side resolvers (0304, 0305) ───────────
--
-- These must match what those functions WRITE, character for character, or the
-- planner will not use them:
--   0304 L157/175 : upper(l2.lot_code)
--   0304 L158/176 : upper(l2.legacy_lot_code)
--   0304 L562/583 : upper(split_part(l.sticker_code, ':', 2))
--
-- The third overlaps sticker_raw_upper in meaning but not in form — the
-- planner matches an index by expression, and a generated column's definition
-- is not substituted into a query's WHERE clause. Both are needed as long as
-- the RPCs spell it as an expression. ~1 MB each at current row count; if the
-- RPCs are later rewritten to read the column, drop lots_sticker_raw_expr_idx.
CREATE INDEX IF NOT EXISTS lots_lot_code_upper_idx
  ON public.lots (upper(lot_code))
  WHERE lot_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS lots_legacy_lot_code_upper_idx
  ON public.lots (upper(legacy_lot_code))
  WHERE legacy_lot_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS lots_sticker_raw_expr_idx
  ON public.lots (upper(split_part(sticker_code, ':', 2)))
  WHERE sticker_code IS NOT NULL;

-- ── 3. Make the new column visible to the storefront role ───────────────────
--
-- `lots` is read by the anon/authenticated roles through RLS for the public
-- storefront. Column privileges are per-column on this table, so a new column
-- is not readable until granted — without this the PostgREST filter returns
-- `column lots.sticker_raw_upper does not exist` to anon callers.
GRANT SELECT (sticker_raw_upper) ON public.lots TO anon, authenticated, service_role;

-- ── 4. Refresh planner statistics ───────────────────────────────────────────
-- The rewrite invalidates the column stats the planner needs to choose the new
-- indexes; without this the first minutes after apply can still pick a scan.
ANALYZE public.lots;
