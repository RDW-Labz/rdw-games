-- 0299 — duplicate_lot(): clone a lot for a SECOND PHYSICAL UNIT
--
-- Request (2026-07-29): "When creating lots, we often receive multiple
-- identical items. Please add a Duplicate Lot button that copies the current
-- lot exactly... The only thing that should not be duplicated is the
-- sticker/lot code. After tapping Duplicate Lot the app should create a new
-- identical lot, prompt the user to scan or bind a new sticker code, and save
-- the new lot with the new sticker."
--
-- The whole point of this function is the distinction that the duplicate-lot
-- incidents of the last month were about:
--
--   RELIST     = the SAME physical item, listed again. Carries lineage
--                (relisted_from_lot_id) and INHERITS the sticker, because the
--                sticker is stuck to that one box.
--   DUPLICATE  = a DIFFERENT physical item that happens to be identical. It
--                gets its own sticker and must carry NO lineage at all.
--
-- So this function deliberately leaves relisted_from_lot_id NULL. Setting it
-- would make the new row look like a relist twin to every guard built since
-- 0275 -- D1 in relist_lot_into_auction, lots_one_active_relist_child, the 0294
-- lineage guard on assign_lots_to_auction -- and a case of six identical items
-- would either be refused or, worse, be treated as six listings of one box.
--
-- What is NOT copied, and why:
--   lot_code                     minted fresh (next_lot_code)
--   sticker_code, qr_token       physical identity; the caller binds a new
--                                sticker to the new box. qr_token defaults to a
--                                fresh uuid, sticker_code stays NULL.
--   client_dedup_token           unique per operator; a copy would collide
--   auction_id, lot_number,      the duplicate starts as an unlisted draft
--   close_at, closed_at          (assign it like any other draft)
--   bid state, winner            never inherited
--   relist lineage/count         see above
--   canceled_*, deleted_*        a fresh row is neither
--   intake_bin_id, intake_at     the new box has not been put away yet
--   flagged_*                    a disposal flag is about one physical item
--   external_code, lpn,          UNIT identity, not product identity. Two boxes
--   import_row_id,               off one pallet share a UPC but not a manifest
--   lot_import_batch_id,         row or an LPN, and copying these would create
--   legacy_lot_code/platform     false manifest matches. Product identity
--                                (upc, asin, brand, model, mpn, the skus) IS
--                                copied -- it genuinely is the same product.
--   photo_urls_original,         rehost bookkeeping for the source row's own
--   photo_rehost_*               fetch attempts; photo_urls itself IS copied
--
-- Note for the caller: `lots` has no dimensions or weight columns (the request
-- mentions them). Every field that does exist is handled above.
--
-- Returns jsonb {ok, lot_id, lot_code} / {ok:false, reason}, matching
-- claim_sticker_code so the app can branch on `reason`.

BEGIN;

CREATE OR REPLACE FUNCTION public.duplicate_lot(p_lot_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_op_id    UUID;
  v_src      lots%ROWTYPE;
  v_new_code TEXT;
  v_new_id   UUID;
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
    lotted_by
  )
  VALUES (
    v_op_id, v_src.warehouse_id, v_new_code, 'draft',
    v_src.title, v_src.description, v_src.category, v_src.category_id, v_src.condition,
    v_src.msrp_cents, v_src.starting_bid_cents, v_src.cost_cents, v_src.reserve_cents,
    v_src.flat_price_cents, v_src.dutch_start_cents, v_src.dutch_floor_cents,
    v_src.dutch_decline_per_minute_cents,
    COALESCE(v_src.photo_urls, '{}'::TEXT[]),
    v_src.brand, v_src.model, v_src.asin, v_src.fnsku, v_src.upc, v_src.mpn,
    v_src.product_sku, v_src.site_sku, v_src.manufacture_sku,
    v_src.source, v_src.vendor, v_src.load_number, v_src.load_id,
    auth.uid()
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('ok', true, 'lot_id', v_new_id, 'lot_code', v_new_code);
END;
$function$;

REVOKE ALL ON FUNCTION public.duplicate_lot(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.duplicate_lot(UUID) TO authenticated;

COMMENT ON FUNCTION public.duplicate_lot(UUID) IS
  '0299: clone a lot for a SECOND physical unit — copies item + product detail '
  'and photos, mints a fresh lot_code, and leaves sticker_code NULL for the '
  'caller to bind. Deliberately sets NO relisted_from_lot_id: a duplicate is a '
  'different box, not the same box relisted, and lineage would make it look '
  'like a relist twin to the 0275/0294 guards. Returns jsonb {ok, lot_id, '
  'lot_code} or {ok:false, reason}.';

COMMIT;
