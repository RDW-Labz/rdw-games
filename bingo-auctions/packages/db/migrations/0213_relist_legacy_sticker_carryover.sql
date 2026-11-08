-- 0213 — relist: carry LEGACY lot codes into the sticker lane
--
-- Tester find (2026-07-02, Test Auction recap): lot BIN-000231 showed only its
-- minted BIN code everywhere and could not be scanned at pickup. Its source,
-- PNK4858854, was imported from the legacy system where the PHYSICAL sticker
-- on the box IS the lot_code (PNK/TEA/BRN + digits — no `{op}-NNNNNN` hyphen
-- format, no sticker_code row value). 0192/0200's carryover only moves
-- `sticker_code`, which is NULL for every legacy source — so each relist of a
-- legacy lot silently orphans the box's physical label. Verified in prod:
-- both sticker-less relist children (BIN-000225 ← PNK4860145, BIN-000231 ←
-- PNK4858854) follow exactly this pattern.
--
-- Fix: when the source has no sticker_code but its lot_code is legacy-shaped
-- (letters+digits, no hyphen), derive the new lot's sticker_code as
-- `{operators.code}:{source.lot_code}` — the same namespaced form
-- claim_sticker_code (0141) mints, so resolve_lot_by_sticker (0150) and the
-- staff checkout matchers resolve the unchanged physical label to the new lot.
-- Guarded by NOT EXISTS against the partial unique index (0141): if some other
-- live row already holds that sticker, we leave NULL rather than blow up the
-- relist.
--
-- Also backfills the two prod lots above (idempotent, guarded the same way).

BEGIN;

CREATE OR REPLACE FUNCTION relist_lot_into_auction(
  p_lot_id UUID,
  p_auction_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src        lots%ROWTYPE;
  v_auction    auctions%ROWTYPE;
  v_new_code   TEXT;
  v_new_lot_id UUID;
  v_lot_number INT;
  v_op_id      UUID;
  v_op_code    TEXT;
  -- 0192 (RELIST-2): capture the source's physical identity so we can move it
  -- onto the new lot. Read off v_src, which is already SELECTed FOR UPDATE
  -- below — no extra query.
  v_src_sticker_code TEXT;
  v_src_qr_token     UUID;
BEGIN
  SELECT * INTO v_src FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_src.id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_src.status NOT IN ('unsold', 'in_inventory', 'relisted') THEN
    RAISE EXCEPTION 'relist_source_wrong_status: %', v_src.status
      USING ERRCODE = 'P0001';
  END IF;

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

  v_op_id := v_src.operator_id;

  -- Stash the source's physical identity before we touch any row. sticker_code
  -- may be NULL (operator never used the operator-chosen sticker lane);
  -- qr_token is always present (NOT NULL DEFAULT).
  v_src_sticker_code := v_src.sticker_code;
  v_src_qr_token     := v_src.qr_token;

  -- 0213: legacy-coded source (letters+digits lot_code, no hyphen — the old
  -- system minted the physical sticker AS the lot code). The box still wears
  -- that label, so derive the namespaced sticker the new lot should hold.
  -- Skipped when the derived value is already claimed by another live row
  -- (partial unique index lots_sticker_code_unique_idx would abort the whole
  -- relist otherwise).
  IF v_src_sticker_code IS NULL AND v_src.lot_code ~ '^[A-Z]{2,8}[0-9]+$' THEN
    SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;
    IF v_op_code IS NOT NULL THEN
      v_src_sticker_code := v_op_code || ':' || v_src.lot_code;
      IF EXISTS (
        SELECT 1 FROM lots
        WHERE sticker_code = v_src_sticker_code AND deleted_at IS NULL
      ) THEN
        v_src_sticker_code := NULL; -- already claimed elsewhere; don't derive
      END IF;
    END IF;
  END IF;

  SELECT next_lot_code(v_op_id) INTO v_new_code;
  IF v_new_code IS NULL THEN
    RAISE EXCEPTION 'relist_lot_code_mint_failed' USING ERRCODE = 'P0001';
  END IF;

  -- 0099 fix: take the advisory lock for the auction BEFORE computing
  -- the next lot_number. Concurrent relist attempts (manual + auto) on
  -- the same target auction serialize here instead of racing on MAX+1.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_auction_id::TEXT, 0));

  SELECT COALESCE(MAX(lot_number), 0) + 1 INTO v_lot_number
  FROM lots WHERE auction_id = p_auction_id;

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
    v_auction.ends_at, 'draft',
    v_src.id, COALESCE(v_src.relist_count, 0) + 1, now(),
    v_src.source, v_src.external_code,
    v_src.intake_at, v_src.intake_bin_id
  )
  RETURNING id INTO v_new_lot_id;

  -- 0192 (RELIST-2) — STEP 1 of 2: CLEAR the source's physical identity FIRST.
  -- The unique partial index lots_sticker_code_unique_idx (0141) and
  -- lots_qr_token_unique (0103) forbid two rows holding the same value at once,
  -- so the source must release sticker_code (-> NULL) and qr_token (-> a FRESH
  -- uuid, since qr_token is NOT NULL) BEFORE the new lot can take them. Folded
  -- into the existing status='relisted' UPDATE that 0097/0099 already did.
  -- 0200: gen_random_uuid() (core PG13+) — uuid_generate_v4 lives in the
  -- `extensions` schema on Supabase and is unresolvable under our search_path.
  UPDATE lots
  SET status = 'relisted',
      sticker_code = NULL,
      qr_token = gen_random_uuid(),
      last_relisted_at = now(),
      updated_at = now()
  WHERE id = p_lot_id;

  -- 0192 (RELIST-2) — STEP 2 of 2: move the source's OLD identity onto the new
  -- (live) lot, so the unchanged physical label/QR on the box now resolves to
  -- it. v_src_sticker_code may now also hold the 0213-derived legacy sticker.
  UPDATE lots
  SET qr_token = v_src_qr_token,
      sticker_code = CASE
        WHEN v_src_sticker_code IS NOT NULL THEN v_src_sticker_code
        ELSE sticker_code
      END,
      updated_at = now()
  WHERE id = v_new_lot_id;

  RETURN v_new_lot_id;
END;
$$;

REVOKE ALL ON FUNCTION relist_lot_into_auction(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relist_lot_into_auction(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION relist_lot_into_auction(UUID, UUID) IS
  '0213: relist helper — mints a new lot in the target auction, moves the '
  'source''s physical identity (sticker_code, qr_token) onto it, and now '
  'derives `{op.code}:{lot_code}` for legacy-coded sources whose sticker IS '
  'their lot_code. See 0097/0099/0192/0200 for lineage.';

-- ---------------------------------------------------------------------------
-- Backfill: the prod relist children that lost their legacy label (verified
-- 2026-07-02: BIN-000225 ← PNK4860145, BIN-000231 ← PNK4858854).
-- Idempotent (sticker_code IS NULL guard) + collision-guarded like the fn.
-- ---------------------------------------------------------------------------
UPDATE lots child
SET sticker_code = o.code || ':' || src.lot_code,
    updated_at = now()
FROM lots src, operators o
WHERE child.relisted_from_lot_id = src.id
  AND o.id = child.operator_id
  AND child.sticker_code IS NULL
  AND child.deleted_at IS NULL
  AND src.sticker_code IS NULL
  AND src.lot_code ~ '^[A-Z]{2,8}[0-9]+$'
  AND NOT EXISTS (
    SELECT 1 FROM lots other
    WHERE other.sticker_code = o.code || ':' || src.lot_code
      AND other.deleted_at IS NULL
  );

COMMIT;
