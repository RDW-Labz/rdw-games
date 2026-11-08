-- Rollback for 0416_duplicate_lot_worker_attribution.sql — standby only.
-- Restores 0326's 1-arg duplicate_lot (no worker attribution). App builds that
-- pass p_lotted_by_worker would then fail to resolve the RPC, so roll the staff
-- OTA back first (or alongside). Function replace only; no table locks.
-- Lots already credited by 0416 or its backfill keep their worker.

BEGIN;

DROP FUNCTION IF EXISTS public.duplicate_lot(uuid, uuid);

CREATE FUNCTION public.duplicate_lot(p_lot_id UUID)
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
    NULL, NULL
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'ok', true,
    'lot_id', v_new_id,
    'lot_code', v_new_code,
    'status', 'pending_intake',
    'on_shelf', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.duplicate_lot(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.duplicate_lot(UUID) TO authenticated;

COMMENT ON FUNCTION public.duplicate_lot(UUID) IS
  'Clone a lot for a SECOND PHYSICAL UNIT (no lineage, no sticker — see 0299). '
  '0326: always mints pending_intake with NO shelf. 0322''s inherited '
  'intake_bin_id made the copy claim its source''s bin, so putting it away '
  'anywhere else read as a move; a duplicate must never claim a shelf it is '
  'not on.';

NOTIFY pgrst, 'reload schema';

COMMIT;
