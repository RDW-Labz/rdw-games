-- 0363 — every bidder scans 135,575 rows to read their own 99.
--
-- ── THE SHAPE ───────────────────────────────────────────────────────────────
-- Same shape as the lot-code scan that took the site down on 2026-09-19 (0362),
-- caught before it tipped over rather than after. A read that costs the whole
-- table, multiplied by a per-user poll, on a table that only grows.
--
-- RLS on notifications_outbox is:
--
--     notifications_outbox_self_read  SELECT  to authenticated
--       USING (target_user_id = (SELECT auth.uid()))
--
-- and the table's indexes are `id`, `idempotency_key`, and three PARTIAL
-- indexes on `created_at` (unprocessed / unemailed / unsmsed). There is no
-- index on target_user_id at all, so every bidder-facing read evaluates that
-- policy by sequential scan.
--
-- Measured on prod, 2026-09-20:
--
--     rows                         135,575
--     distinct target_user_id        1,370
--     average rows per bidder           99
--     most for one bidder           10,506
--     seq_scan                      57,055
--     seq_tup_read           6,960,216,487   <- second-worst on the platform
--     tuples per scan              121,991   <- 90% of the table
--
-- The heaviest caller is the bidder app's unread badge
-- (apps/bidder-app/lib/unread-alerts.ts:50), which asks for an EXACT count and
-- polls every 60 seconds while the app is foregrounded:
--
--     supabase.from('notifications_outbox')
--       .select('id', { count: 'exact', head: true })
--       .gt('created_at', lastSeen)        -- only when a high-water mark exists
--
--     24,590 calls   200.85 ms mean   4,938 s total
--      1,642 calls   177.03 ms mean     291 s total   (first run, no lastSeen)
--
-- An exact count under RLS has to visit every row to decide which ones the
-- caller may see. With no index on the policy column that is the whole table,
-- 90% of it, every 60 seconds, per foregrounded app.
--
-- ── THE INDEX ───────────────────────────────────────────────────────────────
-- One composite index serves all three access patterns on this table:
--
--   1. the RLS predicate               target_user_id = auth.uid()
--   2. the unread badge's filter       ... AND created_at > lastSeen
--   3. the Alerts feed's ordering      ... ORDER BY created_at DESC
--
-- target_user_id leads because it is an equality; created_at DESC follows so
-- the range scan and the ordering both fall out of the same index without a
-- sort. A bidder then reads ~99 index entries instead of 135,575 heap tuples.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
-- Two other real problems on this table, both left alone on purpose because
-- each is a behaviour change and this is meant to be a pure performance fix:
--
--   * Nothing is ever deleted. 4 rows in June, 34,106 in July, 61,399 in
--     August, 40,066 in September. This index makes the growth cheap to read
--     but does not stop it. A retention policy is a product decision — the
--     Alerts tab is a customer-visible history.
--
--   * notifications_outbox_unsmsed_idx has had ZERO scans and covers 100% of
--     the table (smsed_at IS NULL on all 134,048 rows, because SMS has never
--     been sent). It is pure write overhead today, but dropping it is only
--     correct if SMS stays off, which is not this migration's call.
--
-- ── LOCKING ─────────────────────────────────────────────────────────────────
-- Plain CREATE INDEX, not CONCURRENTLY, for the same reason as 0362:
-- CONCURRENTLY cannot run inside a transaction block and BOTH backends of
-- scripts/apply-migrations.js wrap the file in one (pg uses explicit
-- BEGIN/COMMIT at lines 317-319; the Management API runs each call as one
-- implicit transaction). It would fail with SQLSTATE 25001.
--
-- This takes a SHARE lock on notifications_outbox, which blocks INSERTs for
-- the build. Those inserts are not only background producers: place_bid,
-- finalize_lot, buy_flat_price, buy_dutch and the pickup functions call
-- enqueue_notification INSIDE their own transaction (prod, 2026-09-28), so a
-- bid or a lot close that lands during the build waits for it.
--
-- Re-measured 2026-09-28 (not yet applied): 154,636 rows, 1,444 targets,
-- 134 MB. The same build on a same-count local table took 0.64 s; expect
-- about a second on prod. ANALYZE takes SHARE UPDATE EXCLUSIVE and does not
-- block inserts.
--
-- WINDOW: 05:00-07:00 Central, the database-lock window in Rule 9 (inserts
-- average 10-13 an hour then). NOT "after the warehouse closes": 18:00-21:00
-- is peak bidding, 330-370 notification inserts an hour.
--
-- lock_timeout: if the build has to wait for a long transaction, every insert
-- queues behind the waiting build, i.e. bids stall. 3 s aborts it instead;
-- rerun it later. statement_timeout bounds the build itself.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS notifications_outbox_target_recent_idx;
-- Pure addition. No application change ships with this — the existing queries
-- start using it the moment it exists, because it matches predicates they
-- already send.
-- ============================================================================

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE INDEX IF NOT EXISTS notifications_outbox_target_recent_idx
  ON public.notifications_outbox (target_user_id, created_at DESC);

COMMENT ON INDEX public.notifications_outbox_target_recent_idx IS
  '0363: serves the notifications_outbox_self_read RLS predicate '
  '(target_user_id = auth.uid()), the unread badge''s created_at > lastSeen '
  'filter, and the Alerts feed ordering, from one index. Before it, every '
  'bidder-facing read sequentially scanned the table: 57,055 scans reading '
  '6.96 billion tuples, 90% of the table each time, for an average of 99 rows '
  'per bidder.';

-- The planner needs current statistics on target_user_id to choose the new
-- index; without this the first reads after apply can still pick a scan.
ANALYZE public.notifications_outbox;
