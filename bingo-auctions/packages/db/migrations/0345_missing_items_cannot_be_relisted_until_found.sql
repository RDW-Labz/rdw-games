-- 0345 — an item refunded as MISSING cannot go back on an auction until
--        somebody physically finds it and puts it away.
--
-- ── THE OWNER'S RULE ────────────────────────────────────────────────────────
-- 2026-09-02: "I just do not want to refund an item for missing and then
-- relist it on an auction unknowingly that it was a missing item already and
-- then we have another upset customer over an missing item."
--
-- It has already happened. Fourteen relist children have been minted from a
-- lot that was marked missing at pickup. Not one of them was ever put away
-- again first — every single one was relisted while still unaccounted for.
--
-- ── WHAT IT COST ────────────────────────────────────────────────────────────
-- Of those fourteen: ZERO were ever collected successfully. Five were refunded
-- a second time. Three items went missing TWICE — sold, not found, refunded,
-- relisted, sold to a second customer, not found again, refunded again:
--
--     Slatted Platform Bed Frame
--     Modern Reception Desk with Storage
--     Gracie Nightstand
--
-- Each of those is two disappointed buyers and two refunds for one item that
-- nobody has laid hands on since it first went missing.
--
-- ── WHY A TRIGGER AND NOT A CHECK IN THE RPC ────────────────────────────────
-- relist_lot_into_auction() is the main path, but not the only one: the auto
-- relister, the Auction Builder carryover, schedule_relisted_lot and any
-- future caller all end in an INSERT of a row carrying relisted_from_lot_id.
-- Enforcing at the table means no path can miss it, now or later. The Builder
-- also filters these out of its carryover buckets so staff never see a button
-- that will refuse them — this trigger is the floor under that, not the UI.
--
-- ── SCOPE: MISSING ONLY, DELIBERATELY ───────────────────────────────────────
-- The owner's previous platform blocked relisting after ANY refund. That rule
-- was measured against this data before being adopted, and it is far too wide
-- here: of 462 refunded lots currently relistable, only 13 came from a missing
-- outcome. The other 449 have no pickup outcome at all — cancelled before
-- pickup, damaged, card problems — items nobody ever lost. Blocking those
-- would pull 449 sellable lots out of auction building to prevent a harm they
-- cannot cause.
--
-- So this migration blocks the 13 and every future one. A blanket
-- refund-blocks-relist rule remains available as a separate decision.
--
-- ── HOW AN ITEM CLEARS THE BLOCK ────────────────────────────────────────────
-- Put it away. Any of three signals counts, because put-away writes different
-- records depending on which path staff take:
--
--   * lots.intake_at moved past the missing mark (single + batch put-away,
--     and confirm_move for a box that already had a shelf)
--   * a lot_location_events row after it (mig 0328, the audit relocate path)
--   * a bin_assignments row assigned after it (staging for pickup)
--
-- Three signals rather than one on purpose: a guard staff cannot clear from
-- the floor is worse than the bug it prevents. If a box is found and shelved
-- by any route, it becomes relistable again immediately.

BEGIN;

CREATE OR REPLACE FUNCTION public.lots_block_relist_of_missing_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_missing_at timestamptz;
  v_found      boolean;
  v_code       text;
BEGIN
  -- Only relist children are candidates; an ordinary new lot is never blocked.
  IF NEW.relisted_from_lot_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The most recent time the SOURCE lot was called missing at a pickup.
  SELECT max(o.created_at) INTO v_missing_at
    FROM pickup_lot_outcomes o
   WHERE o.lot_id = NEW.relisted_from_lot_id
     AND o.outcome::text = 'missing';

  IF v_missing_at IS NULL THEN
    RETURN NEW;                      -- never went missing; nothing to enforce
  END IF;

  -- Has anyone physically handled it since? Any one of the three counts.
  SELECT
    EXISTS (SELECT 1 FROM lots p
             WHERE p.id = NEW.relisted_from_lot_id
               AND p.intake_at IS NOT NULL
               AND p.intake_at > v_missing_at)
    OR EXISTS (SELECT 1 FROM lot_location_events e
                WHERE e.lot_id = NEW.relisted_from_lot_id
                  AND e.occurred_at > v_missing_at)
    OR EXISTS (SELECT 1 FROM bin_assignments ba
                WHERE ba.lot_id = NEW.relisted_from_lot_id
                  AND ba.assigned_at > v_missing_at)
  INTO v_found;

  IF v_found THEN
    RETURN NEW;                      -- found and shelved — good to sell again
  END IF;

  SELECT COALESCE(p.display_code, p.lot_code, p.id::text) INTO v_code
    FROM lots p WHERE p.id = NEW.relisted_from_lot_id;

  -- Named error code so callers can present it as guidance rather than as a
  -- database failure. The message is written for the person holding a tablet.
  RAISE EXCEPTION
    'relist_blocked_item_missing: % was refunded as missing on % and has not been found since. Locate it and put it away, then it can be listed again.',
    COALESCE(v_code, '(unknown lot)'), v_missing_at::date
    USING ERRCODE = 'P0001';
END;
$function$;

COMMENT ON FUNCTION public.lots_block_relist_of_missing_item() IS
  '0345: refuses a relist child whose source was refunded as missing and has not been put away since. Clears on intake_at, a lot_location_events row, or a bin_assignments row dated after the missing mark.';

DROP TRIGGER IF EXISTS lots_block_relist_of_missing_item_trg ON public.lots;
CREATE TRIGGER lots_block_relist_of_missing_item_trg
  BEFORE INSERT ON public.lots
  FOR EACH ROW
  WHEN (NEW.relisted_from_lot_id IS NOT NULL)
  EXECUTE FUNCTION public.lots_block_relist_of_missing_item();

COMMIT;
