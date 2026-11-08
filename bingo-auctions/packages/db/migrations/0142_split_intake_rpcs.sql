-- migration 0142 — split intake RPCs (W4 — money-loss closer)
--
-- Per docs/state/PLAN-field-mobile-restructure-2026-05-25.md W4:
--   intake_lot_to_bin (tightened):  lot_code | qr_token | sticker_code
--                                   ONLY. Drop LPN/FNSKU/ASIN/external_code/
--                                   legacy_lot_code/lots.id fall-throughs.
--                                   Used by Single, Batch, and new Shelf-Scan
--                                   put-away. Status flex preserved
--                                   (pending_intake OR in_inventory).
--                                   Returns `not_lotted_yet` when no lot
--                                   matches (instead of silent-minting from
--                                   import_rows).
--
--   batch_intake_lot_to_bin (tightened): same resolution as above; per-lot
--                                   error rows. Used by Batch put-away.
--
--   lot_from_manifest (NEW):       resolution helper for the Lotting tab.
--                                   Takes a raw identifier (LPN, FNSKU,
--                                   ASIN, UPC, external_code, title),
--                                   looks it up in import_rows where
--                                   status='pending' AND operator_id=caller,
--                                   returns jsonb with the manifest row
--                                   fields the Lotting UI needs to seed a
--                                   draft. Does NOT mint a lot or update
--                                   import_rows — that''s the Lotting
--                                   client''s job via create_draft_lot.
--
-- ── Why this is the money-loss closer ─────────────────────────────────────
-- Before W4, scanning an un-lotted manifest item during PUT-AWAY silently
-- minted a new `lots` row with status='in_inventory' AND bound it to a bin
-- in one shot — bypassing the lotting review step entirely. Operators were
-- creating real, available-for-sale inventory by scanning during put-away,
-- with no UI confirmation, no price review, no condition normalization
-- vetting, no photo. That''s a silent-mint bug class.
--
-- After W4, the same scan during put-away returns `not_lotted_yet`. The
-- UI tells the operator "open Lotting first" — they review the manifest
-- row, edit the draft lot, save, then scan again to bin it. Lotting and
-- put-away are now strictly separate flows (plan D1).
--
-- ── Backwards compatibility ───────────────────────────────────────────────
-- intake_lot_to_bin / batch_intake_lot_to_bin signatures are UNCHANGED.
-- Existing callers that scan lot_code or qr_token are unaffected. Callers
-- that scan LPN/FNSKU/ASIN/external_code/legacy_lot_code/lots.id will now
-- get `lot_not_found` (single) or `lot_not_found`/`not_lotted_yet` per-row
-- (batch) instead of the previous resolution. UI clients must surface the
-- new `not_lotted_yet` reason — this PR updates intake.tsx and
-- batch-put-away.tsx in-tree alongside the migration.
--
-- ── Resolution order (both intake RPCs) ───────────────────────────────────
--   1. qr_token       (UUID-safe; in-app stickers + claim_prestickered_qr)
--   2. lot_code       ({operator.code}-NNNNNN globally unique)
--   3. sticker_code   ({operator.code}:{raw} globally unique — 0141 W2-bonus)
--
-- If 1+2+3 all miss → return `not_lotted_yet`. No manifest fall-through.
--
-- ── Idempotent ────────────────────────────────────────────────────────────
-- CREATE OR REPLACE for both intake RPCs. CREATE OR REPLACE for the new
-- lot_from_manifest. All function signatures are stable. Re-runnable.

BEGIN;

-- ===========================================================================
-- 1. intake_lot_to_bin (TIGHTENED) — single-lot put-away
-- ===========================================================================
-- Same signature, same return type. Body restricted to the three resolution
-- lanes. The manifest-mint fall-through that ended in
-- `ok_minted_from_manifest` is removed entirely.

CREATE OR REPLACE FUNCTION intake_lot_to_bin(
  p_lot_identifier TEXT,
  p_bin_qr_token   UUID
)
RETURNS intake_lot_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_op_id        UUID;
  v_op_code      TEXT;
  v_lot          lots%ROWTYPE;
  v_bin          bins%ROWTYPE;
  v_bin_operator UUID;
  v_id_clean     TEXT := TRIM(p_lot_identifier);
  v_sticker_full TEXT;
  v_result       intake_lot_result;
BEGIN
  IF auth.uid() IS NULL THEN
    v_result := (false, 'not_authenticated', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    v_result := (false, 'not_operator_staff', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Bin first — fail fast on bad/wrong-operator bin.
  SELECT * INTO v_bin FROM bins
   WHERE qr_token = p_bin_qr_token AND qr_revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found_or_revoked', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_bin.retired_at IS NOT NULL THEN
    v_result := (false, 'bin_retired', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  SELECT operator_id INTO v_bin_operator FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_operator <> v_op_id THEN
    v_result := (false, 'bin_other_operator', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- ── Resolution: qr_token → lot_code → sticker_code (W4 tightened) ────────
  -- 1. qr_token (UUID-safe)
  BEGIN
    SELECT * INTO v_lot FROM lots WHERE qr_token = v_id_clean::UUID;
  EXCEPTION WHEN invalid_text_representation THEN v_lot.id := NULL; END;

  -- 2. lot_code
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots WHERE lot_code = v_id_clean LIMIT 1;
  END IF;

  -- 3. sticker_code (operator-prefixed; raw value never contains ':' — see
  --    lots_sticker_code_format CHECK in 0141)
  IF v_lot.id IS NULL AND v_id_clean NOT LIKE '%:%' THEN
    SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;
    IF v_op_code IS NOT NULL THEN
      v_sticker_full := v_op_code || ':' || v_id_clean;
      SELECT * INTO v_lot FROM lots WHERE sticker_code = v_sticker_full LIMIT 1;
    END IF;
  END IF;

  -- ── No match → not_lotted_yet (W4 — was silent manifest mint) ────────────
  IF v_lot.id IS NULL THEN
    v_result := (false, 'not_lotted_yet', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- ── Cross-operator guard (defensive — should be impossible since
  --    lot_code + qr_token + sticker_code are all globally unique, but
  --    keep the check for the same reason as before) ──────────────────────
  SELECT * INTO v_lot FROM lots WHERE id = v_lot.id FOR UPDATE;
  IF v_lot.operator_id <> v_op_id THEN
    v_result := (false, 'lot_other_operator', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- ── Status flex: pending_intake OR in_inventory (intake/move/no-op) ──────
  IF v_lot.status <> 'pending_intake' AND v_lot.status <> 'in_inventory' THEN
    v_result := (false, 'lot_not_in_intake_state', v_lot.id, v_lot.lot_code, NULL, NULL);
    RETURN v_result;
  END IF;

  UPDATE lots
     SET status        = 'in_inventory',
         intake_bin_id = v_bin.id,
         warehouse_id  = v_bin.warehouse_id,
         intake_at     = now(),
         updated_at    = now()
   WHERE id = v_lot.id;

  v_result := (true, 'ok', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION intake_lot_to_bin(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION intake_lot_to_bin(TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION intake_lot_to_bin(TEXT, UUID) IS
  'W4 (mig 0142): tightened to resolve ONLY via qr_token | lot_code | '
  'sticker_code. Returns `not_lotted_yet` on no match (was silent '
  'manifest-mint pre-W4). Accepts pending_intake OR in_inventory for '
  'move/no-op semantics (W10 will distinguish those outcomes).';

-- ===========================================================================
-- 2. batch_intake_lot_to_bin (TIGHTENED) — Batch Put-away
-- ===========================================================================
-- Same signature + return shape. Per-row resolution restricted to the same
-- three lanes. Unmatched rows return code=`not_lotted_yet` (was
-- `lot_not_found` from the 6-way miss path).

CREATE OR REPLACE FUNCTION batch_intake_lot_to_bin(
  p_lot_identifiers TEXT[],
  p_bin_qr_token    UUID
)
RETURNS TABLE (
  identifier  TEXT,
  ok          BOOLEAN,
  code        TEXT,
  lot_id      UUID,
  lot_code    TEXT,
  bin_code    TEXT,
  error       TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id       UUID;
  v_op_code     TEXT;
  v_bin         bins%ROWTYPE;
  v_bin_op      UUID;
  v_lot         lots%ROWTYPE;
  v_id_clean    TEXT;
  v_sticker_full TEXT;
  v_identifier  TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  -- Bin once. Same fail-fast pattern as the original.
  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT operator_id INTO v_bin_op FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_op IS DISTINCT FROM v_op_id THEN
    RETURN;
  END IF;

  -- Operator code for sticker_code resolution. Cache outside the loop —
  -- it's stable for the duration of the call.
  SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;

  FOREACH v_identifier IN ARRAY p_lot_identifiers LOOP
    v_id_clean := TRIM(v_identifier);
    v_lot      := NULL;

    -- 1. qr_token
    BEGIN
      SELECT * INTO v_lot FROM lots WHERE qr_token = v_id_clean::UUID;
    EXCEPTION WHEN invalid_text_representation THEN v_lot.id := NULL; END;

    -- 2. lot_code
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots WHERE lot_code = v_id_clean LIMIT 1;
    END IF;

    -- 3. sticker_code
    IF v_lot.id IS NULL AND v_op_code IS NOT NULL AND v_id_clean NOT LIKE '%:%' THEN
      v_sticker_full := v_op_code || ':' || v_id_clean;
      SELECT * INTO v_lot FROM lots WHERE sticker_code = v_sticker_full LIMIT 1;
    END IF;

    IF v_lot.id IS NULL THEN
      identifier := v_identifier;
      ok         := false;
      code       := 'not_lotted_yet';
      lot_id     := NULL;
      lot_code   := NULL;
      bin_code   := NULL;
      error      := 'No lot matched — create a draft in Lotting first.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_lot.operator_id <> v_op_id THEN
      identifier := v_identifier;
      ok         := false;
      code       := 'lot_other_operator';
      lot_id     := v_lot.id;
      lot_code   := v_lot.lot_code;
      bin_code   := NULL;
      error      := 'Lot belongs to a different operator.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_lot.status <> 'pending_intake' AND v_lot.status <> 'in_inventory' THEN
      identifier := v_identifier;
      ok         := false;
      code       := 'lot_not_in_intake_state';
      lot_id     := v_lot.id;
      lot_code   := v_lot.lot_code;
      bin_code   := NULL;
      error      := 'Lot is past inventory state (status: ' || v_lot.status || ').';
      RETURN NEXT;
      CONTINUE;
    END IF;

    BEGIN
      UPDATE lots
      SET status        = 'in_inventory',
          intake_bin_id = v_bin.id,
          warehouse_id  = v_bin.warehouse_id,
          intake_at     = now(),
          updated_at    = now()
      WHERE id = v_lot.id;

      identifier := v_identifier;
      ok         := true;
      code       := 'ok';
      lot_id     := v_lot.id;
      lot_code   := v_lot.lot_code;
      bin_code   := v_bin.code;
      error      := NULL;
      RETURN NEXT;

    EXCEPTION WHEN OTHERS THEN
      identifier := v_identifier;
      ok         := false;
      code       := 'update_failed';
      lot_id     := v_lot.id;
      lot_code   := v_lot.lot_code;
      bin_code   := NULL;
      error      := SQLERRM;
      RETURN NEXT;
    END;
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) TO authenticated;

COMMENT ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) IS
  'W4 (mig 0142): same tightening as intake_lot_to_bin. Per-row code is '
  '`not_lotted_yet` for un-lotted identifiers (was `lot_not_found` from '
  'the dropped 6-way fall-through).';

-- ===========================================================================
-- 3. lot_from_manifest (NEW) — Lotting-tab resolution helper
-- ===========================================================================
-- Resolves a raw identifier against the caller's PENDING import_rows. Does
-- NOT mint a lot or modify any row — the Lotting client uses the returned
-- manifest_row data to seed a draft via the existing create_draft_lot RPC.
--
-- Resolution order is the same as the dropped manifest fall-through from
-- 0103's intake_lot_to_bin, minus the now-defunct silent-mint side effects:
--   1. lpn          (Amazon — unit-level)
--   2. fnsku        (Amazon — per-listing)
--   3. asin         (Amazon — per-product)
--   4. upc          (digits-only normalized)
--   5. external_code (operator-pre-existing identifier)
--   6. title        (exact match — last resort)
--
-- Returns jsonb with `ok`, `reason`, and `manifest_row` (full row jsonb) so
-- the client doesn't need a follow-up SELECT.

CREATE OR REPLACE FUNCTION lot_from_manifest(p_identifier TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id     UUID;
  v_id_clean  TEXT := TRIM(p_identifier);
  v_row       import_rows%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;
  IF v_id_clean IS NULL OR LENGTH(v_id_clean) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_identifier');
  END IF;

  -- 1. LPN
  SELECT * INTO v_row FROM import_rows
   WHERE operator_id = v_op_id AND status = 'pending' AND lpn = v_id_clean
   ORDER BY created_at ASC LIMIT 1;

  -- 2. FNSKU
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
     WHERE operator_id = v_op_id AND status = 'pending' AND fnsku = v_id_clean
     ORDER BY created_at ASC LIMIT 1;
  END IF;

  -- 3. ASIN
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
     WHERE operator_id = v_op_id AND status = 'pending' AND asin = v_id_clean
     ORDER BY created_at ASC LIMIT 1;
  END IF;

  -- 4. UPC
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
     WHERE operator_id = v_op_id AND status = 'pending' AND upc = v_id_clean
     ORDER BY created_at ASC LIMIT 1;
  END IF;

  -- 5. external_code
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
     WHERE operator_id = v_op_id AND status = 'pending' AND external_code = v_id_clean
     ORDER BY created_at ASC LIMIT 1;
  END IF;

  -- 6. title (exact match — last resort)
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
     WHERE operator_id = v_op_id AND status = 'pending' AND title = v_id_clean
     ORDER BY created_at ASC LIMIT 1;
  END IF;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'manifest_row_not_found');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'manifest_row', to_jsonb(v_row)
  );
END;
$$;

REVOKE ALL ON FUNCTION lot_from_manifest(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lot_from_manifest(TEXT) TO authenticated;

COMMENT ON FUNCTION lot_from_manifest(TEXT) IS
  'W4 (mig 0142): Lotting-tab resolution helper. Looks a raw identifier '
  'up in the caller''s PENDING import_rows pool (lpn/fnsku/asin/upc/'
  'external_code/title). Returns the full manifest row in jsonb so the '
  'Lotting UI can seed a draft via create_draft_lot. Read-only — does '
  'not mint or modify any row.';

COMMIT;
