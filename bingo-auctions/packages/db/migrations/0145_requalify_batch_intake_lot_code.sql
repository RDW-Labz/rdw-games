-- migration 0145 — re-qualify batch_intake_lot_to_bin's lot_code WHERE
--
-- Self-inflicted bug: my W4 (0142_split_intake_rpcs.sql) and W10
-- (0143_intake_outcome_codes.sql) both DROP+CREATE batch_intake_lot_to_bin
-- with an unqualified `WHERE lot_code = v_id_clean` inside the function
-- body. That's ambiguous because the RETURNS TABLE OUT params include
-- `lot_code TEXT` — Postgres can't decide whether lot_code refers to the
-- column or the OUT param and raises:
--
--   column reference "lot_code" is ambiguous
--
-- The parallel session caught this at the warehouse on 2026-05-25 (PR #62
-- HOTFIX, mig 0142_fix_batch_intake_ambiguous_lot_code.sql, applied to prod
-- at 16:52Z to unblock active put-away workers). Their fix qualified the
-- column as `lots.lot_code = v_id_clean` — one line in 0127's pre-W4
-- function body.
--
-- ── Why the hotfix isn't sufficient on its own ──────────────────────────
-- Migration runner applies files in lexicographic order of filename. Master
-- now contains, in that order:
--
--   0142_fix_batch_intake_ambiguous_lot_code.sql    (parallel session, correct)
--   0142_split_intake_rpcs.sql                       (my W4, unqualified — bug)
--   0143_intake_outcome_codes.sql                    (my W10, unqualified — bug)
--
-- On a fresh DB (CI) the apply sequence is 0142_fix → 0142_split → 0143.
-- The hotfix's qualified WHERE is overwritten by 0142_split's DROP+CREATE,
-- and again by 0143's DROP+CREATE. Final function state is unqualified —
-- broken.
--
-- This migration (0145) CREATE OR REPLACEs batch_intake_lot_to_bin one
-- more time with the qualified WHERE — identical to 0143's body PLUS the
-- `lots.lot_code` qualification. After 0145 applies, the final state is
-- correct regardless of how the earlier migrations interleave.
--
-- ── Why not just edit 0142_split and 0143 in-place? ──────────────────────
-- 0142_split + 0143 are merged. Even though they haven't been applied to
-- prod yet (held by user instruction while workers put away), editing
-- already-merged migrations breaks the "migrations are immutable once
-- merged" convention that all our other migrations follow. A forward
-- correction migration is cheaper than that precedent.
--
-- ── What's preserved from 0143 ────────────────────────────────────────────
-- All W10 three-outcome semantics (ok_intaked / ok_already_here /
-- pending_move), the from_bin_code TABLE column, the W4 tightened
-- resolution (qr_token | lot_code | sticker_code), and the not_lotted_yet
-- fallback. Only the WHERE-clause qualification changes.
--
-- ── Risk: minimal ────────────────────────────────────────────────────────
-- CREATE OR REPLACE on existing function with identical signature. No
-- schema change. Safe to apply while team is operating (the function
-- body briefly swaps, no DDL lock churn).

BEGIN;

CREATE OR REPLACE FUNCTION batch_intake_lot_to_bin(
  p_lot_identifiers TEXT[],
  p_bin_qr_token    UUID
)
RETURNS TABLE (
  identifier    TEXT,
  ok            BOOLEAN,
  code          TEXT,
  lot_id        UUID,
  lot_code      TEXT,
  bin_code      TEXT,
  from_bin_code TEXT,
  error         TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;

  FOREACH v_identifier IN ARRAY p_lot_identifiers LOOP
    v_id_clean := TRIM(v_identifier);
    v_lot      := NULL;

    -- 1. qr_token (UUID-safe)
    BEGIN
      SELECT * INTO v_lot FROM lots WHERE qr_token = v_id_clean::UUID;
    EXCEPTION WHEN invalid_text_representation THEN v_lot.id := NULL; END;

    -- 2. lot_code (0145: column-qualified to disambiguate from the
    --    RETURNS TABLE OUT param `lot_code TEXT`). Same bug class as
    --    0142_fix; preserves the fix on top of 0142_split + 0143.
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots WHERE lots.lot_code = v_id_clean LIMIT 1;
    END IF;

    -- 3. sticker_code (W2-bonus operator-prefix)
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
      bin_code      := NULL;
      from_bin_code := NULL;
      error         := 'Lot belongs to a different operator.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_lot.status <> 'pending_intake' AND v_lot.status <> 'in_inventory' THEN
      identifier    := v_identifier;
      ok            := false;
      code          := 'lot_not_in_intake_state';
      lot_id        := v_lot.id;
      lot_code      := v_lot.lot_code;
      bin_code      := NULL;
      from_bin_code := NULL;
      error         := 'Lot is past inventory state (status: ' || v_lot.status || ').';
      RETURN NEXT;
      CONTINUE;
    END IF;

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
          bin_code      := v_bin.code;
          from_bin_code := v_bin.code;
          error         := NULL;
          RETURN NEXT;
        ELSE
          SELECT code INTO v_old_bin_code FROM bins WHERE id = v_old_bin_id;
          identifier    := v_identifier;
          ok            := false;
          code          := 'pending_move';
          lot_id        := v_lot.id;
          lot_code      := v_lot.lot_code;
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
      bin_code      := NULL;
      from_bin_code := NULL;
      error         := SQLERRM;
      RETURN NEXT;
    END;
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) TO authenticated;

COMMENT ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) IS
  'W10 (mig 0143) + 0145 re-qualification fix. Per-row three-outcome '
  'batch put-away. Code values: ok_intaked / ok_already_here / '
  'pending_move (ok=false; client confirms via confirm_move_lot_to_bin) / '
  'not_lotted_yet / lot_other_operator / lot_not_in_intake_state / '
  'update_failed. lot_code WHERE clauses are column-qualified to avoid '
  'ambiguity with the RETURNS TABLE OUT parameter (cf. PR #62 hotfix).';

COMMIT;
