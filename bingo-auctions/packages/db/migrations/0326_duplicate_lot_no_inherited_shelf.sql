-- 0326 — a duplicate must not inherit its source's shelf.
--
-- Reported through the in-app form 2026-08-18 (Jourdan Parker, v1.0.1):
-- "When creating duplicates and you put one away and you go to put the other
-- one away on a different shelf it's saying that it's already put away on the
-- shelf the first one was put away on."
--
-- That is 0322, and it is my regression. 0322 fixed the real bug — duplicates
-- were minted 'draft', which no list shows, so they were invisible to both the
-- put-away queue and the auction builder. But it fixed it by ALSO copying the
-- source's intake_bin_id, on the theory that a duplicate is the second of
-- several identical boxes stacked on one shelf.
--
-- That theory is wrong in the case that actually happens. Staff duplicate a lot
-- and then put the copies away SEPARATELY, wherever there is room. The copy
-- arrives already claiming shelf A, so scanning it onto shelf B returns
-- 'pending_move' — "Lot is in 7-06-02 — confirm move" — for a box that has
-- never been on any shelf. 0299's original reasoning was right: a duplicate
-- must never claim a shelf it is not on. 0322 talked itself out of it.
--
-- ── WHAT THIS KEEPS ──────────────────────────────────────────────────────────
-- The 'draft' fix, which was the substance of 0322. The duplicate is minted
-- 'pending_intake' — the same state a freshly lotted item gets — so it lands in
-- the put-away queue and becomes in_inventory the ordinary way, by being
-- scanned onto the shelf it is really on. One scan, which staff are performing
-- anyway; Jourdan was mid-scan when they hit the error.
--
-- Assignment to an auction waits for that scan, exactly as it does for every
-- other item. That is the honest trade: 0322 bought earlier assignability with
-- a location the system could not vouch for, and a wrong location costs more
-- than a delayed assignment — it sends someone to a bin that does not hold the
-- item, which is what 0305 and 0311 were spent undoing.

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
    v_op_id, v_src.warehouse_id, v_new_code, 'pending_intake'::lot_status,
    v_src.title, v_src.description, v_src.category, v_src.category_id, v_src.condition,
    v_src.msrp_cents, v_src.starting_bid_cents, v_src.cost_cents, v_src.reserve_cents,
    v_src.flat_price_cents, v_src.dutch_start_cents, v_src.dutch_floor_cents,
    v_src.dutch_decline_per_minute_cents,
    COALESCE(v_src.photo_urls, '{}'::TEXT[]),
    v_src.brand, v_src.model, v_src.asin, v_src.fnsku, v_src.upc, v_src.mpn,
    v_src.product_sku, v_src.site_sku, v_src.manufacture_sku,
    v_src.source, v_src.vendor, v_src.load_number, v_src.load_id,
    auth.uid(),
    -- Never inherited. This box is wherever the person holding it puts it.
    NULL, NULL
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'ok', true,
    'lot_id', v_new_id,
    'lot_code', v_new_code,
    -- Kept from 0322 so the app can say what happened. on_shelf is now always
    -- false; the key stays so a client that reads it does not break.
    'status', 'pending_intake',
    'on_shelf', false
  );
END;
$function$;

COMMENT ON FUNCTION public.duplicate_lot(UUID) IS
  'Clone a lot for a SECOND PHYSICAL UNIT (no lineage, no sticker — see 0299). '
  '0326: always mints pending_intake with NO shelf. 0322''s inherited '
  'intake_bin_id made the copy claim its source''s bin, so putting it away '
  'anywhere else read as a move; a duplicate must never claim a shelf it is '
  'not on.';

-- ---------------------------------------------------------------------------
-- Repair the rows 0322 already minted
-- ---------------------------------------------------------------------------
-- Three lots, all created 2026-08-17, none assigned to an auction. They are
-- identified structurally rather than by lineage because duplicate_lot records
-- none (0299): same operator, same title and same bin as an older sibling, with
-- intake_at equal to created_at — the signature of a shelf that was inherited
-- at insert rather than earned by a scan.
--
-- Scoped hard: no auction_id, and never touch a lot that has actually been
-- scanned somewhere (intake_at later than created_at means a real put-away).
-- Sending these back to pending_intake puts them in the queue so their true
-- shelf gets recorded, which is the same thing staff were trying to do when
-- they hit the error.
UPDATE lots l
SET status        = 'pending_intake',
    intake_bin_id = NULL,
    intake_at     = NULL,
    updated_at    = now()
WHERE l.status = 'in_inventory'
  AND l.auction_id IS NULL
  AND l.deleted_at IS NULL
  AND l.intake_bin_id IS NOT NULL
  AND l.intake_at IS NOT NULL
  AND l.intake_at = l.created_at
  AND l.created_at >= timestamptz '2026-08-17 00:00:00+00'
  AND EXISTS (
    SELECT 1 FROM lots s
    WHERE s.id <> l.id
      AND s.operator_id = l.operator_id
      AND s.title = l.title
      AND s.intake_bin_id = l.intake_bin_id
      AND s.created_at < l.created_at
      AND s.deleted_at IS NULL
  );

COMMIT;
