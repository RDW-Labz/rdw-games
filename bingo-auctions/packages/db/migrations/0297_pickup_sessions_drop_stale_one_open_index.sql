-- 0297 — pickup pass: drop the pre-0293 one-open-session-per-bidder index
--
-- Field report 2026-07-29: "The Pickup Pass is not functioning for customers."
--
-- 0293 moved the pass to one-session-per-building and said so in its own
-- comment: "replaces the one-open-session-per-bidder rule with
-- one-open-session-per-(bidder, warehouse) ... a bidder can hold one legacy
-- session plus one per warehouse without collision."
--
-- It created the new index but never dropped the old one. Both were live:
--
--   pickup_sessions_one_open_idx                    UNIQUE (bidder_id)
--                                                   WHERE status = 'open'
--   pickup_sessions_one_open_per_bidder_warehouse   UNIQUE (bidder_id, warehouse_id)
--                                                   WHERE status = 'open'
--                                                     AND warehouse_id IS NOT NULL
--
-- The stale first index still enforced ONE open session per bidder, so the
-- "legacy plus one per warehouse" model 0293 described could never happen.
--
-- How that broke the pass. getOrCreateOpenSession(bidder, warehouse):
--   1. SELECT ... WHERE bidder_id = $1 AND warehouse_id = $2 AND status='open'
--      -> miss, because the bidder's existing open row is the legacy one with
--         warehouse_id NULL;
--   2. INSERT a warehouse-scoped row -> 23505 against the STALE index;
--   3. the 23505 is swallowed as a benign create race and the SELECT from (1)
--      is retried -> still a miss, because nothing was inserted;
--   4. returns null, and the page renders
--      "Couldn't start a pickup session — please try again in a minute."
--
-- Deterministic, so retrying never clears it. Measured on prod 2026-07-29:
-- 108 open sessions, 107 of them legacy NULL-warehouse, and 49 of the 107
-- bidders with items still to collect were getting no session at all.
--
-- The fix is the DROP 0293 omitted, plus a replacement that preserves the
-- legacy slot 0293 described: at most one open NULL-warehouse session per
-- bidder. Together with the 0293 index the rule is exactly the intended one --
-- one open legacy session, plus one open session per warehouse.
--
-- Index-only. No session rows are touched: closing live sessions could strand
-- a bidder standing at a counter right now, and is not needed to fix the bug.

BEGIN;

-- Superseded by pickup_sessions_one_open_per_bidder_warehouse (0293) plus the
-- NULL-scoped index below.
DROP INDEX IF EXISTS public.pickup_sessions_one_open_idx;

-- The legacy slot. NULL warehouse_id is excluded from the 0293 index (NULL is
-- never equal to itself in a unique index), so without this a bidder could
-- accumulate unlimited open all-locations sessions.
CREATE UNIQUE INDEX IF NOT EXISTS pickup_sessions_one_open_legacy_per_bidder
  ON public.pickup_sessions (bidder_id)
  WHERE status = 'open' AND warehouse_id IS NULL;

COMMENT ON INDEX public.pickup_sessions_one_open_legacy_per_bidder IS
  '0297: at most one open all-locations (warehouse_id IS NULL) session per '
  'bidder. Pairs with pickup_sessions_one_open_per_bidder_warehouse (0293) to '
  'give the model 0293 intended: one legacy session plus one per warehouse. '
  'Replaces pickup_sessions_one_open_idx, whose bidder-wide UNIQUE made '
  'warehouse-scoped session creation fail with 23505 and left affected '
  'bidders with no pickup pass at all.';

COMMIT;
