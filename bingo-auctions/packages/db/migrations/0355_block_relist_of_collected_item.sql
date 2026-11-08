-- 0355 — an item the customer carried out of the building cannot be sold again.
--
-- ── THE REPORT ──────────────────────────────────────────────────────────────
-- Owner, 2026-09-14, about TEA5009103: "I thought we had fixed the issue where
-- an item is physically picked up by the customer and leaves the building, but
-- somehow it does not get marked as picked up in the system. The item then gets
-- placed into another auction, another customer wins it, and we cannot find it
-- because it is already gone."
--
-- ── WHAT 0351 FIXED, AND WHAT IT DID NOT ────────────────────────────────────
-- TEA5009103's parent WAS stamped picked up (2026-08-28 20:24). The no-show
-- sweep forfeited it anyway on 09-02 23:00, flipping it to 'unsold'; it was
-- relisted on 09-07 and resold. All of that predates 0351.
--
-- 0351 is holding: the guard is in the deployed sweep, and across the whole
-- database not one invoice line carries both a pickup stamp and a forfeit
-- stamp. No new cases arrive by that route.
--
-- But 0351 guarded the SWEEP, not the RELIST. Two consequences:
--
--   * It never cleaned up the lots the old sweep had already flipped to
--     'unsold'. 34 of those are sitting relistable right now — picked up,
--     never refunded, most recent pickup 09-10.
--
--   * Nothing checks pickup state at relist time. Once a lot reaches a
--     relistable status by ANY route it stays eligible forever, and 217 have
--     already been relisted in that state. Three went out on 09-11 through the
--     operator console into an auction closing 09-18; two had already attracted
--     bids when the owner pulled them.
--
-- ── WHY A TRIGGER ───────────────────────────────────────────────────────────
-- Same argument 0345 made for the missing-item block, and it has now been
-- proven twice: relist_lot_into_auction is the main path but not the only one.
-- The auto relister, the Auction Builder carryover, schedule_relisted_lot and
-- any future caller all end in an INSERT of a row carrying relisted_from_lot_id.
-- The three that escaped on 09-11 were stamped 'desk_relist', not the field
-- app's path. Enforcing at the table means no path can miss it.
--
-- ── WHAT IS ALLOWED, DELIBERATELY ───────────────────────────────────────────
-- Picked up and THEN refunded is a customer returning or rejecting an item at
-- the counter, and it is routine — 28 such relists in the two days after 0353
-- unlocked them, all correct. Blocking those would break the restock flow the
-- owner asked for. Three ways a lot clears:
--
--   1. the line carries refunded_at (the per-item refund path), or
--   2. the whole invoice is refunded — the invoice-level refund does NOT stamp
--      lines, so reading only the line would wrongly block these 7, or
--   3. somebody physically put it back: a lot_location_events row after the
--      pickup. 0354 made put-away write that row even when the bin does not
--      change, so scanning the box at Put-away clears this from the floor.
--
-- That third route matters. 0345's own header set the rule — "a guard staff
-- cannot clear from the floor is worse than the bug it prevents" — and 0354
-- exists because that guard had no reachable escape. This one ships with its
-- escape already working.
--
-- Measured before writing: of every lot ever picked up, this refuses 34 that
-- are relistable today and allows all 141 that cleared by one of the three
-- routes above.

BEGIN;

CREATE OR REPLACE FUNCTION public.lots_block_relist_of_collected_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_picked_up_at timestamptz;
  v_code         text;
BEGIN
  -- Only relist children are candidates; an ordinary new lot is never blocked.
  IF NEW.relisted_from_lot_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The most recent handover of the SOURCE lot that has not been undone.
  -- A lot normally has one invoice line; MAX is defensive, and picking the
  -- latest is the conservative choice when there is more than one.
  SELECT max(il.picked_up_at) INTO v_picked_up_at
    FROM invoice_lots il
    JOIN invoices i ON i.id = il.invoice_id
   WHERE il.lot_id = NEW.relisted_from_lot_id
     AND il.picked_up_at IS NOT NULL
     -- (1) per-item refund, and (2) whole-invoice refund, which leaves the
     -- line unstamped — reading only the line would block a real return.
     AND il.refunded_at IS NULL
     AND i.status <> 'refunded';

  IF v_picked_up_at IS NULL THEN
    RETURN NEW;                      -- never collected, or already refunded
  END IF;

  -- (3) Put back on the shelf since. 0354 makes Put-away record this even when
  -- the bin is unchanged, so staff can clear the block by scanning the item.
  IF EXISTS (
    SELECT 1 FROM lot_location_events e
     WHERE e.lot_id = NEW.relisted_from_lot_id
       AND e.occurred_at > v_picked_up_at
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(p.display_code, p.lot_code, p.id::text) INTO v_code
    FROM lots p WHERE p.id = NEW.relisted_from_lot_id;

  -- Named error code so callers present guidance, not a database failure.
  -- Written for somebody holding a tablet.
  RAISE EXCEPTION
    'relist_blocked_item_collected: % was collected by a customer on % and has '
    'not been refunded or put back since. If it is on the shelf, scan it at '
    'Put-away first. If the customer kept it, refund the line instead of '
    'relisting it.',
    v_code, to_char(v_picked_up_at AT TIME ZONE 'America/Chicago', 'Mon FMDD')
    USING ERRCODE = 'P0001';
END;
$function$;

COMMENT ON FUNCTION public.lots_block_relist_of_collected_item() IS
  '0355: refuses to mint a relist child from a lot a customer already collected '
  'and that has not been refunded (line or whole invoice) or put back on the '
  'shelf since. Enforced at the table so no relist path can miss it.';

DROP TRIGGER IF EXISTS lots_block_relist_of_collected_item_trg ON public.lots;
CREATE TRIGGER lots_block_relist_of_collected_item_trg
  BEFORE INSERT ON public.lots
  FOR EACH ROW
  WHEN (NEW.relisted_from_lot_id IS NOT NULL)
  EXECUTE FUNCTION public.lots_block_relist_of_collected_item();

COMMIT;
