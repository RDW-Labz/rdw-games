-- rollback for 0392: relist_lot_into_auction(uuid, uuid) exactly as it ran on prod
-- before 0392 (pg_get_functiondef, pulled 2026-10-06, md5
-- 10ace0a308a8b298e8a6d0811356a1ef). Grants restated as prod has them. Apply with
-- the migration workflow in rerun mode, or psql. Tested on the rig 2026-10-06
-- (scripts/prod-rig/relot-double-tap-scenario.sql, part 3).
BEGIN;
CREATE OR REPLACE FUNCTION public.relist_lot_into_auction(p_lot_id uuid, p_auction_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_src        lots%ROWTYPE;
  v_auction    auctions%ROWTYPE;
  v_new_code   TEXT;
  v_new_lot_id UUID;
  v_lot_number INT;
  v_op_id      UUID;
  v_op_code    TEXT;
  v_src_sticker_code TEXT;
  v_src_qr_token     UUID;
  v_active_child_code TEXT;
  v_holder_id  UUID;
BEGIN
  SELECT * INTO v_src FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_src.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- 0353: 'won' is allowed ONLY when the lot has invoice lines and every one
  -- of them is refunded, i.e. no customer has a claim on the item. A lot with
  -- one live unrefunded line still belongs to somebody and stays refused.
  IF v_src.status NOT IN ('unsold', 'in_inventory', 'relisted')
     AND NOT (
       v_src.status = 'won'
       AND EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = p_lot_id)
       AND NOT EXISTS (
         SELECT 1 FROM invoice_lots il
          WHERE il.lot_id = p_lot_id
            AND il.refunded_at IS NULL
       )
     )
  THEN
    RAISE EXCEPTION 'relist_source_wrong_status: %', v_src.status
      USING ERRCODE = 'P0001';
  END IF;

  SELECT c.lot_code INTO v_active_child_code
    FROM lots c
   WHERE c.relisted_from_lot_id = p_lot_id
     AND c.deleted_at IS NULL
     AND (
       c.status IN ('draft', 'scheduled', 'live')
       OR (
         c.status = 'won'
         AND NOT EXISTS (
           SELECT 1 FROM invoice_lots il
            WHERE il.lot_id = c.id
              AND il.refunded_at IS NOT NULL
         )
       )
     )
   LIMIT 1;
  IF v_active_child_code IS NOT NULL THEN
    RAISE EXCEPTION 'relist_source_already_relisted: item already lives on lot %',
      v_active_child_code USING ERRCODE = 'P0001';
  END IF;

  -- 0353: p_auction_id NULL = relot to inventory, unscheduled. The auction
  -- checks below only apply when a caller actually named an auction.
  IF p_auction_id IS NOT NULL THEN
  SELECT * INTO v_auction FROM auctions WHERE id = p_auction_id;
  IF v_auction.id IS NULL THEN
    RAISE EXCEPTION 'relist_target_auction_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_auction.operator_id <> v_src.operator_id THEN
    RAISE EXCEPTION 'relist_cross_tenant' USING ERRCODE = '42501';
  END IF;
  IF v_auction.warehouse_id <> v_src.warehouse_id THEN
    RAISE EXCEPTION 'relist_target_different_warehouse' USING ERRCODE = 'P0001';
  END IF;
  IF v_auction.status NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'relist_target_wrong_status: %', v_auction.status
      USING ERRCODE = 'P0001';
  END IF;
  END IF;

  v_op_id := v_src.operator_id;
  v_src_sticker_code := v_src.sticker_code;
  v_src_qr_token     := v_src.qr_token;

  IF v_src_sticker_code IS NULL AND v_src.lot_code ~ '^[A-Z]{2,8}[0-9]+$' THEN
    SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;
    IF v_op_code IS NOT NULL THEN
      v_src_sticker_code := v_op_code || ':' || v_src.lot_code;
      IF EXISTS (
        SELECT 1 FROM lots
        WHERE sticker_code = v_src_sticker_code AND deleted_at IS NULL
      ) THEN
        v_src_sticker_code := NULL;
      END IF;
    END IF;
  END IF;

  IF v_src_sticker_code IS NULL THEN
    WITH RECURSIVE up AS (
      SELECT l.id, l.relisted_from_lot_id FROM lots l WHERE l.id = p_lot_id
      UNION
      SELECT l.id, l.relisted_from_lot_id
        FROM lots l JOIN up ON l.id = up.relisted_from_lot_id
    ), tree AS (
      SELECT u.id FROM up u WHERE u.relisted_from_lot_id IS NULL
      UNION
      SELECT l.id FROM lots l JOIN tree t ON l.relisted_from_lot_id = t.id
    )
    SELECT h.id, h.sticker_code
      INTO v_holder_id, v_src_sticker_code
      FROM lots h JOIN tree t ON t.id = h.id
     WHERE h.sticker_code IS NOT NULL
       AND h.deleted_at IS NULL
       AND h.id <> p_lot_id
       AND (
         h.status IN ('unsold', 'canceled', 'relisted', 'disposed')
         OR (
           h.status = 'won'
           AND EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = h.id)
           AND NOT EXISTS (
             SELECT 1 FROM invoice_lots il
              WHERE il.lot_id = h.id
                AND il.refunded_at IS NULL
                AND il.forfeited_at IS NULL
           )
         )
       )
     ORDER BY h.created_at DESC
     LIMIT 1;

    IF v_holder_id IS NOT NULL THEN
      UPDATE lots
         SET sticker_code = NULL,
             updated_at   = now()
       WHERE id = v_holder_id;
    END IF;
  END IF;

  SELECT next_lot_code(v_op_id) INTO v_new_code;
  IF v_new_code IS NULL THEN
    RAISE EXCEPTION 'relist_lot_code_mint_failed' USING ERRCODE = 'P0001';
  END IF;

  IF p_auction_id IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_auction_id::TEXT, 0));

  SELECT COALESCE(MAX(lot_number), 0) + 1 INTO v_lot_number
  FROM lots WHERE auction_id = p_auction_id;
  END IF;

  INSERT INTO lots (
    operator_id, auction_id, warehouse_id,
    lot_code, lot_number,
    title, description, category, condition,
    msrp_cents, starting_bid_cents, photo_urls,
    close_at, status,
    relisted_from_lot_id, relist_count, last_relisted_at,
    source, external_code,
    intake_at, intake_bin_id
  )
  VALUES (
    v_op_id, p_auction_id, v_src.warehouse_id,
    v_new_code, v_lot_number,
    v_src.title, v_src.description, v_src.category, v_src.condition,
    v_src.msrp_cents, v_src.starting_bid_cents, COALESCE(v_src.photo_urls, '{}'::TEXT[]),
    v_auction.ends_at,
    (CASE WHEN p_auction_id IS NULL THEN 'in_inventory' ELSE 'scheduled' END)::lot_status,
    v_src.id, COALESCE(v_src.relist_count, 0) + 1, now(),
    v_src.source, v_src.external_code,
    v_src.intake_at, v_src.intake_bin_id
  )
  RETURNING id INTO v_new_lot_id;

  UPDATE lots
  SET status = 'relisted',
      auction_id = NULL,
      lot_number = NULL,
      close_at = NULL,
      sticker_code = NULL,
      qr_token = gen_random_uuid(),
      last_relisted_at = now(),
      updated_at = now()
  WHERE id = p_lot_id;

  UPDATE lots
  SET qr_token = v_src_qr_token,
      sticker_code = CASE
        WHEN v_src_sticker_code IS NOT NULL THEN v_src_sticker_code
        ELSE sticker_code
      END,
      updated_at = now()
  WHERE id = v_new_lot_id;

  IF v_src_sticker_code IS NOT NULL THEN
    UPDATE lot_sticker_pool
       SET claimed_by_lot_id = v_new_lot_id
     WHERE sticker_code = v_src_sticker_code
       AND operator_id = v_op_id
       AND claimed_at IS NOT NULL
       AND claimed_by_lot_id IS DISTINCT FROM v_new_lot_id;
  END IF;

  RETURN v_new_lot_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.relist_lot_into_auction(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.relist_lot_into_auction(uuid, uuid) TO anon, authenticated, service_role;

COMMIT;
