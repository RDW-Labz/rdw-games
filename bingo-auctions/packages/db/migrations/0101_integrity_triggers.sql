-- ============================================================================
-- Migration 0101 — Data integrity triggers
--
-- Addresses two audit findings (docs/auction-lot-audit-plan.md):
--
--   BUG-ARCH-05: lots.bid_count is a denormalized counter maintained by
--                place_bid(). If any new code path or migration touches
--                bids without updating bid_count, the counter drifts.
--                Worse, bid_count is the authorization check for cancelLot
--                and deleteLot — drift to 0 = an authorization bypass.
--                Fix: AFTER INSERT/DELETE trigger on bids that maintains
--                the counter from the canonical source (the bids table).
--
--   BUG-ARCH-11: lots.warehouse_id and auctions.warehouse_id are
--                independent columns. "Auctions are 1:1 with a warehouse"
--                is stated in comments but never enforced. If a future
--                bulk-assign UI lets an operator move a lot across
--                warehouses while keeping the auction reference, the
--                bidder pickup map and shipping-quote flows break.
--                Fix: BEFORE INSERT/UPDATE trigger on lots that rejects
--                rows whose lot.warehouse_id doesn't match the auction's
--                warehouse_id.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. bid_count integrity trigger
-- ---------------------------------------------------------------------------
-- place_bid() in 0084 increments bid_count inside its UPDATE on lots —
-- that path stays unchanged (so the count is set when the lot row UPDATE
-- happens in the same transaction). This trigger is a SAFETY NET for any
-- future direct-INSERT-into-bids path that forgets the increment.
--
-- Implementation note: use a STATEMENT-level trigger that recomputes the
-- count for the affected lot from scratch on any bid INSERT or DELETE.
-- Cheap (single index scan), authoritative, and immune to the row-level
-- ordering hazards of bidirectional updates.

CREATE OR REPLACE FUNCTION sync_lot_bid_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot_id UUID;
BEGIN
  -- Trigger fires per row. NEW/OLD shape depends on op.
  IF TG_OP = 'INSERT' THEN
    v_lot_id := NEW.lot_id;
  ELSIF TG_OP = 'DELETE' THEN
    v_lot_id := OLD.lot_id;
  ELSE
    RETURN NULL;
  END IF;

  -- Recompute from canonical source. Single index scan via bids_lot_idx.
  UPDATE lots
  SET bid_count = (SELECT count(*) FROM bids WHERE lot_id = v_lot_id)
  WHERE id = v_lot_id;

  RETURN NULL;  -- AFTER triggers ignore return
END;
$$;

-- Note: place_bid() already updates bid_count in the same transaction
-- BEFORE this trigger fires (place_bid does the bids INSERT then the
-- lots UPDATE in sequence). Our trigger then recomputes to the same
-- value — idempotent. The trigger is the safety net for any future
-- code path that inserts bids without place_bid()'s explicit update.

DROP TRIGGER IF EXISTS bids_sync_lot_bid_count_ins ON bids;
CREATE TRIGGER bids_sync_lot_bid_count_ins
  AFTER INSERT ON bids
  FOR EACH ROW EXECUTE FUNCTION sync_lot_bid_count();

DROP TRIGGER IF EXISTS bids_sync_lot_bid_count_del ON bids;
CREATE TRIGGER bids_sync_lot_bid_count_del
  AFTER DELETE ON bids
  FOR EACH ROW EXECUTE FUNCTION sync_lot_bid_count();

-- One-time backfill: recompute bid_count from canonical source for any
-- lot whose current counter doesn't match the bids table. Cheap — only
-- touches rows that actually drift. Safe to re-run.
UPDATE lots l
SET bid_count = sub.actual
FROM (
  SELECT lots.id AS lot_id,
         COALESCE(b_count.cnt, 0) AS actual
  FROM lots
  LEFT JOIN (
    SELECT lot_id, count(*) AS cnt FROM bids GROUP BY lot_id
  ) b_count ON b_count.lot_id = lots.id
) sub
WHERE l.id = sub.lot_id
  AND l.bid_count IS DISTINCT FROM sub.actual;

-- ---------------------------------------------------------------------------
-- 2. Lot/auction warehouse_id FK integrity trigger
-- ---------------------------------------------------------------------------
-- When a lot has an auction_id, lot.warehouse_id must match the
-- auction's warehouse_id. Today this is true by convention (every code
-- path that assigns lot.auction_id also sets lot.warehouse_id to the
-- auction's). The trigger enforces it at the DB layer so a future
-- bulk-assign tool can't violate the invariant.

CREATE OR REPLACE FUNCTION check_lot_auction_warehouse()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_auction_warehouse UUID;
BEGIN
  IF NEW.auction_id IS NULL OR NEW.warehouse_id IS NULL THEN
    -- Inventory-only lots (auction_id IS NULL) skip the check entirely.
    RETURN NEW;
  END IF;
  SELECT warehouse_id INTO v_auction_warehouse
  FROM auctions
  WHERE id = NEW.auction_id;
  IF v_auction_warehouse IS NULL THEN
    RAISE EXCEPTION 'lot references auction % which does not exist', NEW.auction_id
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.warehouse_id <> v_auction_warehouse THEN
    RAISE EXCEPTION 'lot.warehouse_id (%) must match auction.warehouse_id (%)',
      NEW.warehouse_id, v_auction_warehouse
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lots_check_auction_warehouse ON lots;
CREATE TRIGGER lots_check_auction_warehouse
  BEFORE INSERT OR UPDATE OF auction_id, warehouse_id ON lots
  FOR EACH ROW EXECUTE FUNCTION check_lot_auction_warehouse();

-- One-time defensive check: surface any existing violations as a NOTICE
-- so they can be cleaned up before this trigger blocks new updates.
-- (We don't fix them automatically — the right value depends on the
-- operator's intent.)
DO $$
DECLARE
  v_bad_count INT;
BEGIN
  SELECT count(*) INTO v_bad_count
  FROM lots l
  JOIN auctions a ON a.id = l.auction_id
  WHERE l.warehouse_id IS DISTINCT FROM a.warehouse_id;
  IF v_bad_count > 0 THEN
    RAISE NOTICE
      '0101: % lot(s) have warehouse_id mismatching their auction. Clean up before next UPDATE.',
      v_bad_count;
  END IF;
END $$;

COMMIT;
