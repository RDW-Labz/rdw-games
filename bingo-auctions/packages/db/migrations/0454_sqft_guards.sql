-- 0454 — sq-ft bidding, PR 4/11: database guards. Two BEFORE triggers, no
-- function body replaced, no table rewrite, no data change.
--
-- WHY
--   Spec: docs/state/SQFT-BIDDING-SPEC.md §4 (PR #473), PR list
--   docs/specs/sqft-bidding-pr-list.md "PR 4" (PR #495). 0451 added the
--   columns (auctions.bid_mode, auctions.unit_start_cents, lots.unit_qty,
--   lots.unit_label); 0453 made place_bid bid per unit. Nothing yet stops a
--   per_unit lot landing in a standard auction (or the reverse), the sq ft
--   changing after bids, or a relist dropping the sq ft. This adds those
--   guards in the database so every path (console, staff app, crons, SQL)
--   gets them.
--
-- WHAT
--   A. lots_sqft_guard — BEFORE INSERT OR UPDATE OF auction_id, unit_qty,
--      unit_label, starting_bid_cents ON lots. Ordinary lot updates (bids,
--      close, status, photos, shelf moves...) don't fire it at all.
--      1. Relist copies the sq ft. A new lot with relisted_from_lot_id and no
--         unit_qty/unit_label of its own takes its parent's (same pattern as
--         0428 lots_inherit_load_on_relist). Every relist path — the console
--         lot page and worklist, the builder's carry-over (bulk), the staff
--         app's Relot (incl. relot after refund) and auto_relist_unsold_lots()
--         — goes through relist_lot_into_auction(), which INSERTs the child,
--         so all of them are covered without touching that function (whose
--         prod body has drifted before, 0285/0442).
--      2. unit_qty and unit_label go together: both set or both empty.
--      3. Lock: unit_qty/unit_label can't change once the lot is live or won,
--         has any bid, or its auction is live or closed.
--      4. Mode match whenever a lot enters an auction (INSERT with auction_id,
--         or auction_id changes) or its sq ft changes while in one:
--           standard auction + lot with unit_qty  → refused
--           per_unit auction + lot without unit_qty → refused
--         This covers assign_lots_to_auction(), relist into an auction, and
--         any direct insert/update. A lot leaving an auction (auction_id →
--         NULL) is never checked.
--      5. Starting price in a per_unit auction (owner 2026-10-26: per lot,
--         with an auction default). On entering a per_unit auction:
--           - the lot keeps its own starting_bid_cents if that is a whole
--             multiple of unit_qty (its own per-unit start, e.g. 1235 for
--             $0.05 × 247) and is not the column default 100 ("not set");
--           - otherwise, if the auction has unit_start_cents, the start
--             becomes unit_start_cents × unit_qty;
--           - otherwise it must already be a whole multiple, or refused.
--         When unit_qty changes on a lot in a per_unit auction (before it is
--         live / bid), the per-unit start stays the same and the total
--         follows the new qty. A starting price edit on a per_unit lot must
--         stay a whole multiple of unit_qty (0453's engine refuses bids on
--         one that isn't: lot_start_not_multiple).
--   B. auctions_sqft_mode_lock — BEFORE UPDATE OF bid_mode ON auctions.
--      bid_mode can't change once the auction is live or closed, once any of
--      its lots has a bid, or while it holds lots priced the other way.
--
--   Standard lots in standard auctions: the trigger only reads (one auctions
--   row by primary key when a lot enters an auction) and returns the row
--   unchanged; no new lock, no new write. Proven before/after identical on
--   the rig (scripts/prod-rig/0454-rig/run.sh).
--
--   Refusals are plain sentences (staff see them as-is), ERRCODE P0001, with
--   a stable HINT code (sqft_*) a later PR can map.
--
--   Known gap (reported, not fixed here): auto_relist_unsold_lots() picks the
--   soonest draft/scheduled auction at the warehouse without looking at
--   bid_mode. With these guards a lot whose mode doesn't match that auction
--   is refused (counted as "failed" by its per-lot EXCEPTION handler, the
--   rest of the run continues) instead of being relisted into the wrong
--   mode. Only matters for operators with auto_relist_mode = 'auto' once a
--   per_unit auction exists.
--
-- ── LOCKS (Rule 9) ───────────────────────────────────────────────────────────
--   CREATE OR REPLACE TRIGGER takes a brief SHARE ROW EXCLUSIVE lock on lots,
--   then on auctions: reads continue, but writes to those tables — every bid
--   updates lots — wait for it. Catalog-only, no table scan or rewrite; the
--   rig measures the whole apply in milliseconds. lock_timeout 3s: if a long
--   transaction holds either table this fails fast instead of queueing bids
--   behind it — just rerun. Window: Thu 2026-10-29 05:00–07:00 CT.
--   (CREATE OR REPLACE TRIGGER, not DROP + CREATE: DROP TRIGGER would take
--   ACCESS EXCLUSIVE and block reads too. Same as 0400 / 0442.)
--
-- Rollback: scripts/prod-rig/0454_ROLLBACK_sqft_guards.sql (drops both
--   triggers and both functions; same lock profile, same window).
-- Read-only prod check first: scripts/prod-rig/0454-rig/preflight-prod.sql.

SET lock_timeout = '3s';

BEGIN;

DO $pre$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'auctions' AND column_name IN ('bid_mode', 'unit_start_cents'))
           OR (table_name = 'lots' AND column_name IN ('unit_qty', 'unit_label')))) <> 4 THEN
    RAISE EXCEPTION '0454: needs 0451 (auctions.bid_mode/unit_start_cents, lots.unit_qty/unit_label). Apply 0451 first.';
  END IF;
END
$pre$;

-- ── A. lots ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lots_sqft_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_qty_changed  boolean;
  v_entering     boolean;
  v_mode         text;
  v_unit_start   integer;
  v_label        text;
BEGIN
  -- 1. Relist copies the parent's sq ft (only when the child names none).
  IF TG_OP = 'INSERT' AND NEW.relisted_from_lot_id IS NOT NULL
     AND NEW.unit_qty IS NULL AND NEW.unit_label IS NULL THEN
    SELECT p.unit_qty, p.unit_label INTO NEW.unit_qty, NEW.unit_label
      FROM lots p
     WHERE p.id = NEW.relisted_from_lot_id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_qty_changed := NEW.unit_qty IS NOT NULL OR NEW.unit_label IS NOT NULL;
    v_entering    := NEW.auction_id IS NOT NULL;
  ELSE
    v_qty_changed := NEW.unit_qty IS DISTINCT FROM OLD.unit_qty
                  OR NEW.unit_label IS DISTINCT FROM OLD.unit_label;
    v_entering    := NEW.auction_id IS NOT NULL
                 AND NEW.auction_id IS DISTINCT FROM OLD.auction_id;
    -- Nothing this guard looks at changed (e.g. SET auction_id = auction_id).
    IF NOT v_qty_changed AND NOT v_entering
       AND NEW.starting_bid_cents IS NOT DISTINCT FROM OLD.starting_bid_cents THEN
      RETURN NEW;
    END IF;
  END IF;

  v_label := coalesce(NEW.unit_label, OLD.unit_label, 'sq ft');

  -- 2. Quantity and unit go together.
  IF v_qty_changed AND (NEW.unit_qty IS NULL) <> (NEW.unit_label IS NULL) THEN
    RAISE EXCEPTION 'Set the quantity and its unit together (for example 247 and sq ft), or leave both empty.'
      USING ERRCODE = 'P0001', HINT = 'sqft_qty_label_pair';
  END IF;

  -- 3. Lock once live, won, bid on, or its auction is live/closed.
  IF TG_OP = 'UPDATE' AND v_qty_changed THEN
    IF OLD.status IN ('live', 'won')
       OR EXISTS (SELECT 1 FROM bids b WHERE b.lot_id = OLD.id)
       OR EXISTS (SELECT 1 FROM auctions a
                   WHERE a.id = OLD.auction_id AND a.status IN ('live', 'closed')) THEN
      RAISE EXCEPTION 'The % on this lot can''t change once it is live or has bids.', v_label
        USING ERRCODE = 'P0001', HINT = 'sqft_locked';
    END IF;
  END IF;

  -- 4./5. Mode match and starting price, only while in an auction.
  IF NEW.auction_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- A lot that is and was standard, staying in the same auction: nothing to check.
  IF NOT v_entering AND NOT v_qty_changed AND NEW.unit_qty IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT a.bid_mode, a.unit_start_cents INTO v_mode, v_unit_start
    FROM auctions a
   WHERE a.id = NEW.auction_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- the foreign key / check_lot_auction_warehouse refuse this
  END IF;

  IF v_mode IS DISTINCT FROM 'per_unit' THEN
    IF NEW.unit_qty IS NOT NULL AND (v_entering OR v_qty_changed) THEN
      RAISE EXCEPTION 'This lot is priced per %. It can only go in an auction priced per %.', v_label, v_label
        USING ERRCODE = 'P0001', HINT = 'sqft_lot_in_standard_auction';
    END IF;
    RETURN NEW;
  END IF;

  -- per_unit auction
  IF NEW.unit_qty IS NULL THEN
    RAISE EXCEPTION 'This auction is priced per sq ft. Add the lot''s sq ft before it goes in.'
      USING ERRCODE = 'P0001', HINT = 'sqft_auction_needs_qty';
  END IF;

  IF v_entering THEN
    IF v_unit_start IS NOT NULL
       AND (NEW.starting_bid_cents % NEW.unit_qty <> 0 OR NEW.starting_bid_cents = 100) THEN
      NEW.starting_bid_cents := v_unit_start::bigint * NEW.unit_qty;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND v_qty_changed AND OLD.unit_qty IS NOT NULL
        AND NEW.starting_bid_cents = OLD.starting_bid_cents
        AND OLD.starting_bid_cents % OLD.unit_qty = 0 THEN
    -- Same per-unit start, total follows the new quantity.
    NEW.starting_bid_cents := (OLD.starting_bid_cents / OLD.unit_qty) * NEW.unit_qty;
  END IF;

  IF NEW.starting_bid_cents % NEW.unit_qty <> 0 THEN
    RAISE EXCEPTION 'A starting price of $% doesn''t split evenly over % %. Set a starting price per % on the lot or the auction.',
      to_char(NEW.starting_bid_cents / 100.0, 'FM999999990.00'), NEW.unit_qty, v_label, v_label
      USING ERRCODE = 'P0001', HINT = 'sqft_start_not_whole';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.lots_sqft_guard() FROM PUBLIC;

COMMENT ON FUNCTION public.lots_sqft_guard() IS
  '0454 sq-ft guards on lots: relist copies unit_qty/unit_label; qty+label '
  'together; locked once live/won/bid/auction live or closed; per_unit lot '
  'only in a per_unit auction and the reverse; per_unit starting price is a '
  'whole multiple of unit_qty (auction unit_start_cents × qty when the lot '
  'has no own per-unit start). Standard lots: read-only, row unchanged.';

-- LOCK: SHARE ROW EXCLUSIVE on public.lots, brief (catalog only).
CREATE OR REPLACE TRIGGER lots_sqft_guard
  BEFORE INSERT OR UPDATE OF auction_id, unit_qty, unit_label, starting_bid_cents
  ON public.lots
  FOR EACH ROW EXECUTE FUNCTION public.lots_sqft_guard();

-- ── B. auctions ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.auctions_sqft_mode_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.bid_mode IS NOT DISTINCT FROM OLD.bid_mode THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('live', 'closed') THEN
    RAISE EXCEPTION 'How this auction is priced (per sq ft or standard) can''t change once it is live.'
      USING ERRCODE = 'P0001', HINT = 'sqft_mode_locked';
  END IF;
  IF EXISTS (SELECT 1 FROM lots l JOIN bids b ON b.lot_id = l.id
              WHERE l.auction_id = OLD.id) THEN
    RAISE EXCEPTION 'How this auction is priced (per sq ft or standard) can''t change once it has bids.'
      USING ERRCODE = 'P0001', HINT = 'sqft_mode_locked';
  END IF;
  IF EXISTS (SELECT 1 FROM lots l
              WHERE l.auction_id = OLD.id
                AND l.deleted_at IS NULL
                AND (l.unit_qty IS NULL) = (NEW.bid_mode = 'per_unit')) THEN
    RAISE EXCEPTION 'This auction has lots priced the other way. Take them out first, then change how it is priced.'
      USING ERRCODE = 'P0001', HINT = 'sqft_mode_lots_mismatch';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.auctions_sqft_mode_lock() FROM PUBLIC;

COMMENT ON FUNCTION public.auctions_sqft_mode_lock() IS
  '0454: auctions.bid_mode can''t change once live/closed, once any lot has '
  'a bid, or while the auction holds lots priced the other way.';

-- LOCK: SHARE ROW EXCLUSIVE on public.auctions, brief (catalog only).
CREATE OR REPLACE TRIGGER auctions_sqft_mode_lock
  BEFORE UPDATE OF bid_mode
  ON public.auctions
  FOR EACH ROW EXECUTE FUNCTION public.auctions_sqft_mode_lock();

COMMIT;
