-- 0344 — a destroyed item must not hold its auction open forever.
--
-- ── THE BUG, AS THE OWNER SAW IT ────────────────────────────────────────────
-- /browse showed two auctions with a green LIVE badge whose end dates had
-- already passed — "Click Before It's Gone" 41 hours over, "Take Four Bids" 17.
-- Every lot in both had closed correctly. It was the auction row that never
-- flipped.
--
-- ── ROOT CAUSE ──────────────────────────────────────────────────────────────
-- advance_auction_lifecycle (pg_cron, every minute — running fine, 10,108
-- consecutive successes) closes an auction only when EVERY child lot is in a
-- terminal status. Its list:
--
--     won, unsold, canceled, relisted        (+ draft in the time-gated path)
--
-- 'disposed' is missing. That status was added later, with the Destroy action
-- built for Tammy's 2026-08-20 report ("we need a destroy button for items
-- broken to pieces such as mirrors or sinks"). The lifecycle function was
-- written before it existed and nobody came back to widen the list — the
-- classic shape of this bug: a new enum member, and every closed-set test
-- written against the old enum silently starts answering "no".
--
-- One destroyed item is enough. "Take Four Bids" was pinned open by exactly
-- one, against 96 won and 15 unsold.
--
-- ── WHY 'disposed' IS TERMINAL AND THE OTHERS ARE NOT ───────────────────────
-- The remaining uncounted statuses are scheduled, live, pending_intake and
-- in_inventory. Each of those is a lot that can still legitimately move —
-- it can open, sell, or be relisted — so an auction holding one genuinely is
-- not finished, and adding them would close auctions that are still running.
--
-- 'disposed' is the one that cannot. The item was destroyed; it will never
-- sell, never relist, never be picked up. Leaving it out of the terminal set
-- does not protect anything — it just guarantees the auction never closes.
--
-- ── WHY THIS MATTERS BEYOND A WRONG BADGE ───────────────────────────────────
-- An auction stuck at 'live' keeps its lots inside FEED_AUCTION_STATUSES, so
-- they stay in the Meta catalog feed; it keeps the auction on /browse under a
-- LIVE badge with a date in the past, which is what a customer sees; and it
-- leaves closed_at NULL, so anything that reasons about "the last completed
-- auction" skips it. This would have recurred on every future auction where
-- staff destroyed a single item — which, at 138 disposed lots and counting, is
-- most of them.
--
-- Both terminal lists are widened: the fast path (b) and the draft-tolerant
-- time-gated path (b2). Everything else in the function is reproduced verbatim.

BEGIN;

CREATE OR REPLACE FUNCTION public.advance_auction_lifecycle()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_promoted_live         INT := 0;
  v_promoted_closed       INT := 0;
  v_promoted_closed_stale INT := 0;
BEGIN
  -- (a) scheduled → live when any child lot is currently live or won.
  --     (unchanged from 0096)
  WITH eligible AS (
    SELECT a.id
    FROM auctions a
    WHERE a.status = 'scheduled'
      AND EXISTS (
        SELECT 1 FROM lots l
        WHERE l.auction_id = a.id
          AND l.status IN ('live', 'won')
      )
  ),
  promoted AS (
    UPDATE auctions
    SET status = 'live', updated_at = now()
    WHERE id IN (SELECT id FROM eligible)
    RETURNING id
  )
  SELECT count(*) INTO v_promoted_live FROM promoted;

  -- (b) live → closed when EVERY child lot is terminal and at least one lot
  --     exists. Fast path (no time gate) for the clean case.
  --
  --     0344: 'disposed' added. A destroyed item is as finished as a sold one;
  --     omitting it pinned two live auctions open past their end date.
  WITH eligible AS (
    SELECT a.id
    FROM auctions a
    WHERE a.status IN ('scheduled', 'live')
      AND EXISTS (SELECT 1 FROM lots l WHERE l.auction_id = a.id)
      AND NOT EXISTS (
        SELECT 1 FROM lots l
        WHERE l.auction_id = a.id
          AND l.status NOT IN ('won', 'unsold', 'canceled', 'relisted', 'disposed')
      )
  ),
  promoted AS (
    UPDATE auctions
    SET
      status = 'closed',
      closed_at = COALESCE(closed_at, now()),
      updated_at = now()
    WHERE id IN (SELECT id FROM eligible)
    RETURNING id
  )
  SELECT count(*) INTO v_promoted_closed FROM promoted;

  -- (b2) live/scheduled → closed when the auction's bidding WINDOW HAS PASSED
  --      and every NON-DRAFT lot is terminal. This is the draft-tolerant
  --      fallback: never-published 'draft' lots must not pin a finished auction
  --      open forever (prod bug 2026-06-02). Time-gated by a 10-minute grace
  --      past COALESCE(last_lot_ends_at, ends_at) so auctions still inside their
  --      window — where an operator may be adding/curating draft lots — are
  --      left alone. Requires >=1 lot. Draft lots are intentionally NOT mutated.
  --
  --      0344: 'disposed' added here too. The 2026-06-02 fix and this one are
  --      the same bug twice: a lot status that can never progress, left out of
  --      the terminal set, holding a finished auction open.
  WITH eligible AS (
    SELECT a.id
    FROM auctions a
    WHERE a.status IN ('scheduled', 'live')
      AND COALESCE(a.last_lot_ends_at, a.ends_at) IS NOT NULL
      AND COALESCE(a.last_lot_ends_at, a.ends_at) < now() - interval '10 minutes'
      AND EXISTS (SELECT 1 FROM lots l WHERE l.auction_id = a.id)
      AND NOT EXISTS (
        SELECT 1 FROM lots l
        WHERE l.auction_id = a.id
          AND l.status NOT IN ('won', 'unsold', 'canceled', 'relisted', 'draft', 'disposed')
      )
  ),
  promoted AS (
    UPDATE auctions
    SET
      status = 'closed',
      closed_at = COALESCE(closed_at, now()),
      updated_at = now()
    WHERE id IN (SELECT id FROM eligible)
    RETURNING id
  )
  SELECT count(*) INTO v_promoted_closed_stale FROM promoted;

  RETURN jsonb_build_object(
    'promoted_live', v_promoted_live,
    'promoted_closed', v_promoted_closed,
    'promoted_closed_stale_draft', v_promoted_closed_stale,
    'at', now()
  );
END;
$function$;

COMMENT ON FUNCTION public.advance_auction_lifecycle() IS
  '0096 + 0344: scheduled→live, and live→closed once every child lot is terminal. '
  'Terminal = won/unsold/canceled/relisted/disposed (+draft on the time-gated path). '
  'Runs every minute via pg_cron job advance-auction-lifecycle.';

COMMIT;
