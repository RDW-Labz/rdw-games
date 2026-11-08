-- migration 0147 — W6-P0 pickup money-loss guards
--
-- Per docs/state/PLAN-field-mobile-restructure-2026-05-25.md W6 P0:
--   1. Block premature pickup — `assign_lot_to_bin` RPC must require
--      `lots.status='won'` before staging.
--   2. Incomplete pickup warning — `staff_confirm_pickup` RPC must compare
--      submitted codes against all `invoice_lots` and surface missing.
--
-- ── Why these are money-loss closers ─────────────────────────────────────
-- P0 #1: pre-W6, assign_lot_to_bin had NO check that the lot was won
-- (its status could be pending_intake / in_inventory / scheduled / etc.).
-- A picker could stage any lot, creating a bin_assignment for an unwon
-- item. Downstream, staff_confirm_pickup would happily mark the unwon
-- lot as picked up against the wrong invoice — operator loses inventory.
--
-- P0 #2: pre-W6, staff_confirm_pickup marked pickups complete regardless
-- of how many of the invoice''s lots were actually confirmed. Bidder
-- could leave with 3 of 5 items, operator''s books say pickup complete,
-- the 2 missing items are out the door but invisible. After W6, the RPC
-- defaults to REFUSING completion on incomplete pickups (`p_allow_incomplete
-- BOOLEAN DEFAULT FALSE`); the UI must explicitly override after
-- surfacing the missing codes to the operator.
--
-- ── Backwards compat ─────────────────────────────────────────────────────
-- assign_lot_to_bin: signature unchanged. New rejection code `lot_not_won`
-- is returned in `reason` for any unwon lot. Existing callers that pass
-- only `won` lots see no behavior change.
--
-- staff_confirm_pickup: DROP + CREATE adds a third param `p_allow_incomplete
-- BOOLEAN DEFAULT FALSE`. JS callers using named params (the supabase-js
-- pattern, e.g. `rpc("staff_confirm_pickup", { p_invoice_id, p_lot_codes })`)
-- continue to work and get the safer DEFAULT FALSE behavior — i.e. RAISES
-- if any invoice lot is missing from p_lot_codes (and not already picked).
-- The pickup-verify.tsx client is updated in the same PR to surface a
-- "missing lots" modal with a "Confirm Partial" button that re-calls with
-- p_allow_incomplete=true.
--
-- ── Schema change ────────────────────────────────────────────────────────
-- staff_confirm_pickup_result composite type gains `out_missing_lot_codes
-- TEXT[]`. Same pattern as W10''s intake_lot_result extension: DROP the
-- function (which depends on the type), ALTER TYPE ADD ATTRIBUTE, then
-- re-CREATE the function. All in one transaction.
--
-- ── Idempotency ───────────────────────────────────────────────────────────
-- DO-block guard around ALTER TYPE ADD ATTRIBUTE. CREATE OR REPLACE for
-- assign_lot_to_bin. DROP + CREATE for staff_confirm_pickup.

BEGIN;

-- ===========================================================================
-- 1. assign_lot_to_bin — add status='won' guard
-- ===========================================================================

CREATE OR REPLACE FUNCTION assign_lot_to_bin(
  p_lot_id UUID,
  p_bin_qr_token UUID,
  p_photo_url TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS assign_lot_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_operator UUID;
  v_lot lots%ROWTYPE;
  v_bin bins%ROWTYPE;
  v_assignment_id UUID;
  v_invoice_record RECORD;
  v_result assign_lot_result;
BEGIN
  IF v_user IS NULL THEN
    v_result := (false, 'not_authenticated', NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT operator_id INTO v_operator FROM operator_users WHERE user_id = v_user;
  IF v_operator IS NULL THEN
    v_result := (false, 'not_operator_staff', NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id;
  IF NOT FOUND THEN
    v_result := (false, 'lot_not_found', NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.operator_id <> v_operator THEN
    v_result := (false, 'lot_other_operator', NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- W6-P0 #1: ONLY won lots can be staged for pickup. Staging an unwon
  -- lot would create a bin_assignment that staff_confirm_pickup could
  -- later flip to picked_up against the wrong invoice — money loss.
  IF v_lot.status <> 'won' THEN
    v_result := (false, 'lot_not_won', NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found', NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM warehouses
    WHERE id = v_bin.warehouse_id AND operator_id = v_operator
  ) THEN
    v_result := (false, 'bin_other_operator', NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  INSERT INTO bin_assignments (lot_id, bin_id, operator_user_id, status, staging_photo_url, notes)
  VALUES (
    p_lot_id, v_bin.id,
    (SELECT id FROM operator_users WHERE user_id = v_user LIMIT 1),
    'staged', p_photo_url, p_notes
  )
  RETURNING id INTO v_assignment_id;

  -- Pickup-ready notification (unchanged from 0006).
  FOR v_invoice_record IN
    SELECT i.id AS invoice_id, i.bidder_id
    FROM invoice_lots il
    JOIN invoices i ON i.id = il.invoice_id
    WHERE il.lot_id = p_lot_id AND i.status = 'paid'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM invoice_lots il
      WHERE il.invoice_id = v_invoice_record.invoice_id
        AND NOT EXISTS (
          SELECT 1 FROM bin_assignments ba
          WHERE ba.lot_id = il.lot_id
            AND ba.status IN ('staged', 'picked_up')
        )
    ) THEN
      PERFORM enqueue_notification(
        'pickup_ready',
        v_invoice_record.bidder_id,
        jsonb_build_object('invoice_id', v_invoice_record.invoice_id),
        'pickup_ready:' || v_invoice_record.invoice_id::TEXT
      );
    END IF;
  END LOOP;

  v_result := (true, 'ok', v_assignment_id, v_bin.id, v_bin.code);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION assign_lot_to_bin(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assign_lot_to_bin(UUID, UUID, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION assign_lot_to_bin(UUID, UUID, TEXT, TEXT) IS
  'W6-P0 (mig 0147): hardened with lot status=won guard. Returns '
  '`lot_not_won` for any non-won lot. Closes the silent-stage bug class '
  'where an unwon lot could be staged for pickup and later flipped to '
  'picked_up against the wrong invoice.';

-- ===========================================================================
-- 2. staff_confirm_pickup_result — extend with out_missing_lot_codes
-- ===========================================================================

DROP FUNCTION IF EXISTS staff_confirm_pickup(UUID, TEXT[]);
DROP FUNCTION IF EXISTS staff_confirm_pickup(UUID, TEXT[], BOOLEAN);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute pa
    JOIN pg_type pt ON pa.attrelid = pt.typrelid
    WHERE pt.typname = 'staff_confirm_pickup_result'
      AND pa.attname = 'out_missing_lot_codes'
      AND NOT pa.attisdropped
  ) THEN
    ALTER TYPE staff_confirm_pickup_result ADD ATTRIBUTE out_missing_lot_codes TEXT[];
  END IF;
END $$;

COMMENT ON TYPE staff_confirm_pickup_result IS
  'Return shape for staff_confirm_pickup. W6-P0 (mig 0147) adds '
  'out_missing_lot_codes — the lot codes that were in the invoice but '
  'NOT in the caller''s p_lot_codes (and not already picked up). '
  'Empty array on a complete pickup.';

-- ===========================================================================
-- 3. staff_confirm_pickup — re-created with missing-codes + allow_incomplete
-- ===========================================================================

CREATE FUNCTION staff_confirm_pickup(
  p_invoice_id        UUID,
  p_lot_codes         TEXT[],
  p_allow_incomplete  BOOLEAN DEFAULT FALSE
)
RETURNS staff_confirm_pickup_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user           UUID := auth.uid();
  v_operator       UUID;
  v_invoice        invoices%ROWTYPE;
  v_pickup         pickups%ROWTYPE;
  v_lot_id         UUID;
  v_lot_code       TEXT;
  v_already_picked INT := 0;
  v_not_found_ct   INT := 0;
  v_picked_ct      INT := 0;
  v_missing        TEXT[];
  v_warning        TEXT := NULL;
  v_result         staff_confirm_pickup_result;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT operator_id INTO v_operator
    FROM operator_users WHERE user_id = v_user LIMIT 1;
  IF v_operator IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff';
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found';
  END IF;
  IF v_invoice.operator_id <> v_operator THEN
    RAISE EXCEPTION 'invoice_other_operator';
  END IF;
  IF v_invoice.status <> 'paid' THEN
    RAISE EXCEPTION 'invoice_not_paid';
  END IF;

  SELECT * INTO v_pickup FROM pickups WHERE invoice_id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pickup_not_found';
  END IF;

  -- Idempotency (unchanged).
  IF v_pickup.status = 'completed' THEN
    v_result := (
      v_pickup.id,
      (SELECT count(*) FROM bin_assignments ba
       JOIN invoice_lots il ON il.lot_id = ba.lot_id
       WHERE il.invoice_id = p_invoice_id AND ba.status = 'picked_up'),
      'already_completed',
      ARRAY[]::TEXT[]
    );
    RETURN v_result;
  END IF;

  -- ── W6-P0 #2: detect missing lots BEFORE committing the flip ─────────
  -- A lot is "missing" if it''s in invoice_lots for this invoice, NOT in
  -- p_lot_codes, and NOT already picked up (a prior partial pickup
  -- shouldn''t flag those as missing this round).
  SELECT COALESCE(array_agg(l.lot_code ORDER BY l.lot_code), ARRAY[]::TEXT[])
    INTO v_missing
  FROM invoice_lots il
  JOIN lots l ON l.id = il.lot_id
  WHERE il.invoice_id = p_invoice_id
    AND NOT (l.lot_code = ANY(p_lot_codes))
    AND NOT EXISTS (
      SELECT 1 FROM bin_assignments ba
      WHERE ba.lot_id = l.id AND ba.status = 'picked_up'
    );

  IF array_length(v_missing, 1) > 0 AND NOT COALESCE(p_allow_incomplete, FALSE) THEN
    -- Money-loss guard: refuse completion until caller explicitly opts into
    -- partial pickup. Detail string includes the missing codes so the
    -- client UI can surface them in the "confirm partial?" modal.
    RAISE EXCEPTION 'pickup_incomplete: %', array_to_string(v_missing, ',')
      USING DETAIL = array_to_string(v_missing, ',');
  END IF;

  -- ── Per-lot flip (unchanged) ─────────────────────────────────────────
  FOREACH v_lot_code IN ARRAY p_lot_codes
  LOOP
    SELECT l.id INTO v_lot_id
    FROM lots l
    JOIN invoice_lots il ON il.lot_id = l.id
    WHERE il.invoice_id = p_invoice_id
      AND l.lot_code = v_lot_code
    LIMIT 1;

    IF NOT FOUND THEN
      v_not_found_ct := v_not_found_ct + 1;
      CONTINUE;
    END IF;

    WITH latest AS (
      SELECT ba.id
      FROM bin_assignments ba
      WHERE ba.lot_id = v_lot_id
      ORDER BY ba.assigned_at DESC
      LIMIT 1
    )
    UPDATE bin_assignments ba
       SET status = 'picked_up', picked_up_at = now()
      FROM latest
     WHERE ba.id = latest.id
       AND ba.status = 'staged';

    IF FOUND THEN
      v_picked_ct := v_picked_ct + 1;
    ELSE
      v_already_picked := v_already_picked + 1;
    END IF;
  END LOOP;

  -- ── Close the pickup row ──────────────────────────────────────────────
  UPDATE pickups
     SET checked_in_at = COALESCE(checked_in_at, now()),
         completed_at  = now(),
         status        = 'completed',
         updated_at    = now()
   WHERE id = v_pickup.id;

  -- ── Notification (unchanged) ─────────────────────────────────────────
  PERFORM enqueue_notification(
    'pickup_confirmed',
    v_invoice.bidder_id,
    jsonb_build_object(
      'invoice_id', p_invoice_id,
      'lots_picked', v_picked_ct,
      'lots_missing', array_length(v_missing, 1)
    ),
    'pickup_confirmed:staff:' || p_invoice_id::TEXT
  );

  -- ── Warning ──────────────────────────────────────────────────────────
  IF v_not_found_ct > 0 OR v_already_picked > 0 OR array_length(v_missing, 1) > 0 THEN
    v_warning := format(
      '%s lot(s) not in invoice; %s already picked up; %s missing (partial pickup)',
      v_not_found_ct, v_already_picked, COALESCE(array_length(v_missing, 1), 0)
    );
  END IF;

  v_result := (v_pickup.id, v_picked_ct, v_warning, COALESCE(v_missing, ARRAY[]::TEXT[]));
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION staff_confirm_pickup(UUID, TEXT[], BOOLEAN) TO authenticated;

COMMENT ON FUNCTION staff_confirm_pickup(UUID, TEXT[], BOOLEAN) IS
  'W6-P0 (mig 0147): same shape as 0079''s RPC PLUS p_allow_incomplete '
  'BOOLEAN DEFAULT FALSE. Default behavior REFUSES completion if any '
  'invoice lot is missing from p_lot_codes (and not already picked up), '
  'raising `pickup_incomplete: <missing codes>`. Caller must explicitly '
  'pass p_allow_incomplete=TRUE to override after operator confirms a '
  'partial pickup in the UI. out_missing_lot_codes is populated on the '
  'success path too (will be empty if everything was scanned).';

COMMIT;
