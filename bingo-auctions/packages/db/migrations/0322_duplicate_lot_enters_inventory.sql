-- 0322 — a duplicated lot must land in a workflow, not between them.
--
-- Reported 2026-08-14: "When we create a duplicate, none of the duplicated
-- items appear in inventory as put away. We can only find them by searching for
-- each item individually, and we cannot assign them to an auction."
--
-- ── WHY 'draft' IS THE BUG ───────────────────────────────────────────────────
-- 0299 mints the duplicate with status 'draft'. Nothing lists 'draft':
--
--   staff worklist    counts pending_intake | in_inventory | unsold  (draft: no)
--   auction builder   "available" source requires status='in_inventory'
--
-- So a duplicate falls out of BOTH the put-away queue and the assignable pool.
-- It exists, it is correct, and it is reachable only by searching for it by
-- name one at a time — precisely what was reported. 'draft' is not a resting
-- state for a physical box; it is a gap between two workflows.
--
-- ── WHAT 0299 GOT RIGHT, AND WHY THIS DOES NOT SIMPLY OVERRIDE IT ────────────
-- 0299 deliberately does not copy intake_bin_id / intake_at, reasoning "the new
-- box has not been put away yet." That is sound for the case it was written
-- against and this migration keeps it: a duplicate must never claim a shelf it
-- is not on, or staff get sent to a bin that does not hold the item — the exact
-- failure 0311/0305 spent two migrations undoing.
--
-- The distinction 0299 missed is that the source's own shelf answers it:
--
--   source HAS a shelf (intake_bin_id + intake_at)
--       The duplicate is the second of several identical boxes off one pallet,
--       stacked with its twin. It is genuinely on that shelf. Carry the intake
--       fields and mint 'in_inventory' — findable in inventory, assignable to
--       an auction, no put-away round trip for a box already on the rack.
--
--   source has NO shelf
--       Nothing is known about where the new box is, so claiming one would be
--       the lie 0299 was guarding against. Mint 'pending_intake' — the same
--       state a freshly lotted item gets — so it enters the put-away queue and
--       becomes in_inventory the normal way, by being scanned onto a shelf.
--
-- Either way it lands in a workflow. Put-away can always move it afterwards;
-- that is a normal relocation, not a correction.
--
-- Everything else 0299 decided is untouched — no lineage, no sticker, no
-- unit-identity columns. See the 0299 header for that reasoning; it still
-- holds, and this migration is deliberately narrow.

BEGIN;

CREATE OR REPLACE FUNCTION public.duplicate_lot(p_lot_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_op_id     UUID;
  v_src       lots%ROWTYPE;
  v_new_code  TEXT;
  v_new_id    UUID;
  v_on_shelf  BOOLEAN;
  v_status    lot_status;
  v_bin_id    UUID;
  v_intake_at TIMESTAMPTZ;
BEGIN
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  SELECT * INTO v_src FROM lots WHERE id = p_lot_id AND deleted_at IS NULL;
  IF v_src.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_src.operator_id <> v_op_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_other_operator');
  END IF;

  v_new_code := next_lot_code(v_op_id);
  IF v_new_code IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_code_mint_failed');
  END IF;

  -- 0322: BOTH intake columns, not either. A row with a bin but no intake_at
  -- (or the reverse) is a half-written put-away, and inheriting half of one
  -- would produce a lot that reads as shelved to one query and not to another.
  v_on_shelf := v_src.intake_bin_id IS NOT NULL AND v_src.intake_at IS NOT NULL;

  IF v_on_shelf THEN
    v_status    := 'in_inventory'::lot_status;
    v_bin_id    := v_src.intake_bin_id;
    -- now(), NOT the source's intake_at: this box reached the shelf when it was
    -- duplicated, and age-in-inventory on the aging report must not be
    -- backdated to a date this unit was never there for.
    v_intake_at := now();
  ELSE
    v_status    := 'pending_intake'::lot_status;
    v_bin_id    := NULL;
    v_intake_at := NULL;
  END IF;

  INSERT INTO lots (
    operator_id, warehouse_id, lot_code, status,
    title, description, category, category_id, condition,
    msrp_cents, starting_bid_cents, cost_cents, reserve_cents,
    flat_price_cents, dutch_start_cents, dutch_floor_cents,
    dutch_decline_per_minute_cents,
    photo_urls,
    brand, model, asin, fnsku, upc, mpn,
    product_sku, site_sku, manufacture_sku,
    source, vendor, load_number, load_id,
    lotted_by,
    intake_bin_id, intake_at
  )
  VALUES (
    v_op_id, v_src.warehouse_id, v_new_code, v_status,
    v_src.title, v_src.description, v_src.category, v_src.category_id, v_src.condition,
    v_src.msrp_cents, v_src.starting_bid_cents, v_src.cost_cents, v_src.reserve_cents,
    v_src.flat_price_cents, v_src.dutch_start_cents, v_src.dutch_floor_cents,
    v_src.dutch_decline_per_minute_cents,
    COALESCE(v_src.photo_urls, '{}'::TEXT[]),
    v_src.brand, v_src.model, v_src.asin, v_src.fnsku, v_src.upc, v_src.mpn,
    v_src.product_sku, v_src.site_sku, v_src.manufacture_sku,
    v_src.source, v_src.vendor, v_src.load_number, v_src.load_id,
    auth.uid(),
    v_bin_id, v_intake_at
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'ok', true,
    'lot_id', v_new_id,
    'lot_code', v_new_code,
    -- 0322: so the app can tell the operator which of the two things happened
    -- rather than leaving them to discover it in a list later.
    'status', v_status::TEXT,
    'on_shelf', v_on_shelf
  );
END;
$function$;

COMMENT ON FUNCTION public.duplicate_lot(UUID) IS
  'Clone a lot for a SECOND PHYSICAL UNIT (no lineage, no sticker — see 0299). '
  '0322: mints in_inventory on the source''s shelf when the source is put away, '
  'else pending_intake, so the duplicate always lands in a workflow instead of '
  'the unlisted ''draft'' gap between them.';

COMMIT;
