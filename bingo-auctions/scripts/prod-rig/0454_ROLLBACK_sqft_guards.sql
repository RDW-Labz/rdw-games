-- ROLLBACK for 0454_sqft_guards.sql — removes both sq-ft guard triggers and
-- their functions. Back to 0451 + 0453 behaviour: no lock on unit_qty /
-- unit_label / bid_mode, no mode match on assign, relist doesn't copy the
-- sq ft. No data is touched (0454 changed no rows; a starting price it set
-- while assigning a lot into a per_unit auction stays as set).
--
-- LOCKS: DROP TRIGGER takes a brief ACCESS EXCLUSIVE lock on lots, then on
-- auctions (catalog only, no scan) — reads wait too, for milliseconds.
-- lock_timeout 3s: fails fast instead of queueing bids; just rerun.
-- Window: 05:00–07:00 CT, unless 0454 itself is what's broken (then now).
-- Idempotent: safe to run twice, or when 0454 was never applied.

SET lock_timeout = '3s';

BEGIN;

DROP TRIGGER IF EXISTS lots_sqft_guard ON public.lots;
DROP TRIGGER IF EXISTS auctions_sqft_mode_lock ON public.auctions;
DROP FUNCTION IF EXISTS public.lots_sqft_guard();
DROP FUNCTION IF EXISTS public.auctions_sqft_mode_lock();

COMMIT;
