-- 0295 — RECOVERY: re-commit mig 0273's putaway RPCs, which reached prod but
--        were never committed to the repo.
--
-- ── Why this migration exists ──────────────────────────────────────────────
--
-- `_schema_migrations` on prod (npwseclcxcatjhgjrtwe) records
-- `0273_putaway_location_regardless_of_status.sql` applied 2026-07-16 19:32:46
-- by runner@runnervm3jd5f, but no such file exists in packages/db/migrations —
-- the repo jumps 0272 -> 0277. The three RPCs below carry `0273` markers in
-- their live prod bodies and differ from the repo's most recent definitions
-- (0250 / 0252), so a from-scratch rebuild currently LOSES this behaviour and
-- silently reinstates a status gate that prod removed two weeks ago.
--
-- These bodies are transcribed verbatim from prod via `pg_get_functiondef`
-- on 2026-07-29. This migration is therefore a NO-OP against prod (it replaces
-- each function with what is already there) and a genuine repair everywhere
-- else. That asymmetry is the entire point: it makes a clean rebuild match
-- production.
--
-- ── What 0273 actually changed ─────────────────────────────────────────────
--
-- 1. The status gate is REMOVED from all three RPCs. A lot's physical location
--    is independent of its auction/invoice state (established by
--    `audit_relocate_lot`, mig 0248), so a lot in ANY status may have its bin
--    corrected. `pending_intake` still flips to `in_inventory`; every other
--    status is location-only and its auction state is left untouched.
--
-- 2. Staged pickup assignments are kept in lockstep — `bin_assignments` rows
--    with `status = 'staged'` follow the lot to the new bin (mirroring
--    `audit_relocate_lot`), so a won lot moved between bins shows the correct
--    customer-facing pickup location. No-op when the lot has no staged row.
--
-- Grants are intentionally not restated: prod carries the default Supabase ACL
-- ({postgres,anon,authenticated,service_role} = EXECUTE) and CREATE OR REPLACE
-- preserves the existing ACL, so restating would risk diverging from prod
-- rather than matching it.
--
-- Still outstanding after this migration (tracked, not fixed here): 0274, 0275
-- and 0276 are likewise applied on prod and absent from the repo. Their
-- observable behaviour was subsequently re-established by 0291
-- (admin_cancel_lot) and 0285 / 0290 (relist dedup guards), so unlike 0273 they
-- are not currently a rebuild hazard.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. intake_lot_to_bin — single-scan putaway.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.intake_lot_to_bin(p_lot_identifier text, p_bin_qr_token uuid)
 RETURNS intake_lot_result
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_op_id        UUID;
  v_lot          lots%ROWTYPE;
  v_bin          bins%ROWTYPE;
  v_bin_operator UUID;
  v_id_clean     TEXT := TRIM(p_lot_identifier);
  v_old_bin_id   UUID;
  v_old_bin_code TEXT;
  v_result       intake_lot_result;
  v_find         jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    v_result := (false, 'not_authenticated', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    v_result := (false, 'not_operator_staff', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_bin FROM bins
   WHERE qr_token = p_bin_qr_token AND qr_revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found_or_revoked', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_bin.retired_at IS NOT NULL THEN
    v_result := (false, 'bin_retired', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  SELECT operator_id INTO v_bin_operator FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_operator <> v_op_id THEN
    v_result := (false, 'bin_other_operator', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  v_find := public._find_lot_by_scan(ARRAY[v_id_clean]);
  IF NOT (v_find->>'ok')::boolean THEN
    v_result := (false, 'not_lotted_yet', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = (v_find->'lot'->>'id')::UUID FOR UPDATE;
  IF v_lot.operator_id <> v_op_id THEN
    v_result := (false, 'lot_other_operator', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- 0273: status gate REMOVED (see batch_intake_lot_to_bin / audit_relocate_lot).
  -- Any status may have its location corrected; pending_intake still flips to
  -- in_inventory, everything else is location-only.

  v_old_bin_id := v_lot.intake_bin_id;

  IF v_lot.status = 'pending_intake' THEN
    UPDATE lots
       SET status        = 'in_inventory',
           intake_bin_id = v_bin.id,
           warehouse_id  = v_bin.warehouse_id,
           intake_at     = now(),
           updated_at    = now()
     WHERE id = v_lot.id;
    v_result := (true, 'ok_intaked', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, NULL);
    RETURN v_result;
  END IF;

  -- Non-pending lot with no bin yet — place it directly. LOCATION-ONLY.
  IF v_old_bin_id IS NULL THEN
    UPDATE lots
       SET intake_bin_id = v_bin.id,
           warehouse_id  = v_bin.warehouse_id,
           updated_at    = now()
     WHERE id = v_lot.id;

    -- 0273: sync the staged pickup assignment too (mirrors audit_relocate_lot).
    UPDATE bin_assignments
       SET bin_id = v_bin.id
     WHERE lot_id = v_lot.id AND status = 'staged';

    v_result := (true, 'ok_intaked', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, NULL);
    RETURN v_result;
  END IF;

  IF v_old_bin_id IS NOT DISTINCT FROM v_bin.id THEN
    v_result := (true, 'ok_already_here', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_bin.code);
    RETURN v_result;
  END IF;

  SELECT code INTO v_old_bin_code FROM bins WHERE id = v_old_bin_id;
  v_result := (false, 'pending_move', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_old_bin_code);
  RETURN v_result;
END
$function$;

COMMENT ON FUNCTION public.intake_lot_to_bin(text, uuid) IS
  '0295 (recovers 0273): single-scan putaway. No status gate — a lot in any '
  'status may have its bin corrected. pending_intake flips to in_inventory; '
  'every other status is location-only. Staged pickup assignments follow the lot.';

-- ---------------------------------------------------------------------------
-- 2. batch_intake_lot_to_bin — multi-scan putaway.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.batch_intake_lot_to_bin(p_lot_identifiers text[], p_bin_qr_token uuid)
 RETURNS TABLE(identifier text, ok boolean, code text, lot_id uuid, lot_code text, sticker_code text, bin_code text, from_bin_code text, error text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_op_id        UUID;
  v_op_code      TEXT;
  v_bin          bins%ROWTYPE;
  v_bin_op       UUID;
  v_lot          lots%ROWTYPE;
  v_id_clean     TEXT;
  v_sticker_full TEXT;
  v_old_bin_id   UUID;
  v_old_bin_code TEXT;
  v_identifier   TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT operator_id INTO v_bin_op FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_op IS DISTINCT FROM v_op_id THEN
    RETURN;
  END IF;

  -- `code` resolves to operators.code (the column) under the use_column pragma.
  SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;

  FOREACH v_identifier IN ARRAY p_lot_identifiers LOOP
    v_id_clean := TRIM(v_identifier);
    v_lot      := NULL;

    -- 1. qr_token (UUID-safe)
    BEGIN
      SELECT * INTO v_lot FROM lots WHERE qr_token = v_id_clean::UUID;
    EXCEPTION WHEN invalid_text_representation THEN v_lot.id := NULL; END;

    -- 2. lot_code (column-qualified; redundant under use_column but kept
    --    for parity with 0175).
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots WHERE lots.lot_code = v_id_clean LIMIT 1;
    END IF;

    -- 3. sticker_code (W2-bonus operator-prefix). `sticker_code` in this WHERE
    --    resolves to the COLUMN under use_column (not the new OUT param).
    IF v_lot.id IS NULL AND v_op_code IS NOT NULL AND v_id_clean NOT LIKE '%:%' THEN
      v_sticker_full := v_op_code || ':' || v_id_clean;
      SELECT * INTO v_lot FROM lots WHERE sticker_code = v_sticker_full LIMIT 1;
    END IF;

    IF v_lot.id IS NULL THEN
      identifier    := v_identifier;
      ok            := false;
      code          := 'not_lotted_yet';
      lot_id        := NULL;
      lot_code      := NULL;
      sticker_code  := NULL;
      bin_code      := NULL;
      from_bin_code := NULL;
      error         := 'No lot matched — create a draft in Lotting first.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_lot.operator_id <> v_op_id THEN
      identifier    := v_identifier;
      ok            := false;
      code          := 'lot_other_operator';
      lot_id        := v_lot.id;
      lot_code      := v_lot.lot_code;
      sticker_code  := v_lot.sticker_code;
      bin_code      := NULL;
      from_bin_code := NULL;
      error         := 'Lot belongs to a different operator.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- 0273: status gate REMOVED. A lot's physical location is independent of
    -- its auction/invoice state (see audit_relocate_lot, mig 0248), so any
    -- status may have its bin corrected here. pending_intake still flips to
    -- in_inventory below; every other status is location-only.

    -- W10: branch by outcome.
    BEGIN
      IF v_lot.status = 'pending_intake' THEN
        UPDATE lots
        SET status        = 'in_inventory',
            intake_bin_id = v_bin.id,
            warehouse_id  = v_bin.warehouse_id,
            intake_at     = now(),
            updated_at    = now()
        WHERE id = v_lot.id;

        identifier    := v_identifier;
        ok            := true;
        code          := 'ok_intaked';
        lot_id        := v_lot.id;
        lot_code      := v_lot.lot_code;
        sticker_code  := v_lot.sticker_code;
        bin_code      := v_bin.code;
        from_bin_code := NULL;
        error         := NULL;
        RETURN NEXT;
      ELSIF v_lot.intake_bin_id IS NULL THEN
        -- Non-pending lot with no bin yet — place it directly. LOCATION-ONLY:
        -- status stays as-is (flipping draft → in_inventory could fight the
        -- relist pipeline; live/won/unsold keep their auction state).
        UPDATE lots
        SET intake_bin_id = v_bin.id,
            warehouse_id  = v_bin.warehouse_id,
            updated_at    = now()
        WHERE id = v_lot.id;

        -- 0273: keep the customer-facing pickup bin in lockstep — move the
        -- staged pickup assignment too (mirrors audit_relocate_lot). No-op when
        -- the lot has no staged assignment.
        UPDATE bin_assignments
           SET bin_id = v_bin.id
         WHERE lot_id = v_lot.id AND status = 'staged';

        identifier    := v_identifier;
        ok            := true;
        code          := 'ok_intaked';
        lot_id        := v_lot.id;
        lot_code      := v_lot.lot_code;
        sticker_code  := v_lot.sticker_code;
        bin_code      := v_bin.code;
        from_bin_code := NULL;
        error         := NULL;
        RETURN NEXT;
      ELSE
        v_old_bin_id := v_lot.intake_bin_id;
        IF v_old_bin_id IS NOT DISTINCT FROM v_bin.id THEN
          identifier    := v_identifier;
          ok            := true;
          code          := 'ok_already_here';
          lot_id        := v_lot.id;
          lot_code      := v_lot.lot_code;
          sticker_code  := v_lot.sticker_code;
          bin_code      := v_bin.code;
          from_bin_code := v_bin.code;
          error         := NULL;
          RETURN NEXT;
        ELSE
          -- `code` resolves to bins.code (the column) under use_column.
          SELECT code INTO v_old_bin_code FROM bins WHERE id = v_old_bin_id;
          identifier    := v_identifier;
          ok            := false;
          code          := 'pending_move';
          lot_id        := v_lot.id;
          lot_code      := v_lot.lot_code;
          sticker_code  := v_lot.sticker_code;
          bin_code      := v_bin.code;
          from_bin_code := v_old_bin_code;
          error         := 'Lot is in ' || COALESCE(v_old_bin_code, '?') || ' — confirm move.';
          RETURN NEXT;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      identifier    := v_identifier;
      ok            := false;
      code          := 'update_failed';
      lot_id        := v_lot.id;
      lot_code      := v_lot.lot_code;
      sticker_code  := v_lot.sticker_code;
      bin_code      := NULL;
      from_bin_code := NULL;
      error         := SQLERRM;
      RETURN NEXT;
    END;
  END LOOP;

  RETURN;
END;
$function$;

COMMENT ON FUNCTION public.batch_intake_lot_to_bin(text[], uuid) IS
  '0295 (recovers 0273): multi-scan putaway. No status gate — see '
  'intake_lot_to_bin. Staged pickup assignments follow the lot to the new bin.';

-- ---------------------------------------------------------------------------
-- 3. confirm_move_lot_to_bin — operator-confirmed bin-to-bin move.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_move_lot_to_bin(p_lot_id uuid, p_bin_qr_token uuid)
 RETURNS intake_lot_result
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_op_id        UUID;
  v_lot          lots%ROWTYPE;
  v_bin          bins%ROWTYPE;
  v_bin_operator UUID;
  v_old_bin_id   UUID;
  v_old_bin_code TEXT;
  v_result       intake_lot_result;
BEGIN
  IF auth.uid() IS NULL THEN
    v_result := (false, 'not_authenticated', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    v_result := (false, 'not_operator_staff', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_bin FROM bins
   WHERE qr_token = p_bin_qr_token AND qr_revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found_or_revoked', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_bin.retired_at IS NOT NULL THEN
    v_result := (false, 'bin_retired', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  SELECT operator_id INTO v_bin_operator FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_operator <> v_op_id THEN
    v_result := (false, 'bin_other_operator', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN
    v_result := (false, 'lot_not_found', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    v_result := (false, 'lot_other_operator', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- 0273: status gate REMOVED. Moves are location-only (status is never touched
  -- here), so a lot in ANY status may be moved between bins — matching
  -- audit_relocate_lot and the widened intake_lot_to_bin above.

  v_old_bin_id := v_lot.intake_bin_id;
  SELECT code INTO v_old_bin_code FROM bins WHERE id = v_old_bin_id;

  IF v_old_bin_id IS NOT DISTINCT FROM v_bin.id THEN
    v_result := (true, 'ok_already_here', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_bin.code);
    RETURN v_result;
  END IF;

  UPDATE lots
     SET intake_bin_id = v_bin.id,
         warehouse_id  = v_bin.warehouse_id,
         intake_at     = now(),
         updated_at    = now()
   WHERE id = v_lot.id;

  -- 0273: sync the staged pickup assignment too (mirrors audit_relocate_lot),
  -- so a won lot moved bins here shows the right pickup location. No-op when the
  -- lot has no staged assignment.
  UPDATE bin_assignments
     SET bin_id = v_bin.id
   WHERE lot_id = v_lot.id AND status = 'staged';

  v_result := (true, 'ok_moved', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_old_bin_code);
  RETURN v_result;
END
$function$;

COMMENT ON FUNCTION public.confirm_move_lot_to_bin(uuid, uuid) IS
  '0295 (recovers 0273): operator-confirmed bin-to-bin move. No status gate — '
  'moves are location-only. Staged pickup assignments follow the lot.';

COMMIT;
