-- 0416 — a duplicated lot is credited to a worker, not to nobody.
--
-- Found read-only 2026-10-14: on Oct 13, 42 of 108 Crandall lots carried no
-- lotted_by_worker, and 40 of those were Duplicate Lot copies of a lot Tim or
-- Lane had lotted. Worker Productivity reads lotted_by_worker and nothing else
-- (0321), so every duplicate was a lot nobody made.
--
-- Two halves of the same gap:
--   * the staff app called duplicate_lot(p_lot_id) with no worker — fixed in
--     the app, which now passes the clocked-in PIN worker exactly as the
--     create-draft and relist paths do (getActiveLottingWorkerId());
--   * duplicate_lot (0299 → 0322 → 0326) copied lotted_by (the shared station
--     login) but never lotted_by_worker.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────────
-- duplicate_lot gains an optional p_lotted_by_worker. The worker is
--   1. the passed worker, validated by resolve_active_worker (0321): it must be
--      active and belong to the caller's operator, else it resolves to NULL;
--   2. otherwise the SOURCE lot's lotted_by_worker. Old app builds in the field
--      never pass the argument; for them the copy is credited to whoever lotted
--      the box it was copied from, which is who was standing there on Oct 13.
-- Attribution stays best-effort and never blocks the duplicate (0321's rule).
--
-- Everything else is 0326's body unchanged: no lineage, no sticker, no shelf,
-- pending_intake.
--
-- ── WHY DROP + CREATE, NOT AN OVERLOAD ───────────────────────────────────────
-- 0321 added overloads so it would not have to retype long bodies. Here the
-- 1-arg path must change too (old builds must inherit the source's worker), so
-- the body is rewritten either way. Adding a DEFAULT NULL second argument next
-- to the existing 1-arg function would make every 1-arg call ambiguous (42725),
-- so the old signature is dropped and replaced by one function whose second
-- argument defaults to NULL. Old callers — rpc('duplicate_lot', {p_lot_id}) —
-- resolve to it unchanged. DROP and CREATE are in one transaction, so there is
-- no moment without the function. Grants are re-issued as 0299 set them.
--
-- Locks: a function replace only. No table is touched.

BEGIN;

DROP FUNCTION IF EXISTS public.duplicate_lot(uuid);

CREATE FUNCTION public.duplicate_lot(
  p_lot_id           UUID,
  p_lotted_by_worker UUID DEFAULT NULL
)
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
  v_worker_id UUID;
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

  -- 0416: the clocked-in worker when the app sends a valid one; else whoever
  -- lotted the source (same operator — checked just above).
  v_worker_id := COALESCE(
    public.resolve_active_worker(p_lotted_by_worker),
    v_src.lotted_by_worker
  );

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
    lotted_by, lotted_by_worker,
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
    auth.uid(), v_worker_id,
    -- Never inherited (0326). This box is wherever the person holding it puts it.
    NULL, NULL
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'ok', true,
    'lot_id', v_new_id,
    'lot_code', v_new_code,
    -- Kept from 0322 so the app can say what happened. on_shelf is always
    -- false since 0326; the key stays so a client that reads it does not break.
    'status', 'pending_intake',
    'on_shelf', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.duplicate_lot(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.duplicate_lot(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.duplicate_lot(UUID, UUID) IS
  'Clone a lot for a SECOND PHYSICAL UNIT (no lineage, no sticker — see 0299; '
  'no shelf, pending_intake — see 0326). 0416: credits lotted_by_worker to the '
  'passed PIN worker (validated by resolve_active_worker), else to the source '
  'lot''s worker. p_lotted_by_worker defaults to NULL so pre-0416 app builds '
  'calling with p_lot_id alone keep working.';

NOTIFY pgrst, 'reload schema';

COMMIT;
