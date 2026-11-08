-- ============================================================================
-- Pickup RPCs — atomic operations for picker staging and bidder pickup.
--
-- assign_lot_to_bin(lot_id, bin_qr_token, photo_url, notes)
--   Picker side. Caller must be operator staff (current_operator_id() match).
--   Inserts a new bin_assignments row with status='staged'.
--   Returns the new assignment.
--
-- confirm_pickup(bin_qr_token)
--   Bidder side. Caller must be a bidder. Looks up the bin and finds all
--   bin_assignments where:
--     - bin matches the scanned QR
--     - lot is in an invoice_lots row whose invoice belongs to this bidder
--     - invoice.status = 'paid'
--     - bin_assignments.status = 'staged'
--   Flips each to 'picked_up' atomically. Returns the count and the lot IDs.
-- ============================================================================

DROP TYPE IF EXISTS assign_lot_result CASCADE;
CREATE TYPE assign_lot_result AS (
  ok BOOLEAN,
  reason TEXT,
  assignment_id UUID,
  bin_id UUID,
  bin_code TEXT
);

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
  v_role operator_user_role;
  v_lot lots%ROWTYPE;
  v_bin bins%ROWTYPE;
  v_assignment_id UUID;
  v_result assign_lot_result;
BEGIN
  IF v_user IS NULL THEN
    v_result := (false, 'not_authenticated', NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT operator_id, role INTO v_operator, v_role
  FROM operator_users WHERE user_id = v_user;

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

  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found', NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Verify the bin belongs to a warehouse this operator owns
  IF NOT EXISTS (
    SELECT 1 FROM warehouses
    WHERE id = v_bin.warehouse_id AND operator_id = v_operator
  ) THEN
    v_result := (false, 'bin_other_operator', NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  INSERT INTO bin_assignments (
    lot_id, bin_id, operator_user_id, status, staging_photo_url, notes
  )
  VALUES (
    p_lot_id, v_bin.id,
    (SELECT id FROM operator_users WHERE user_id = v_user LIMIT 1),
    'staged', p_photo_url, p_notes
  )
  RETURNING id INTO v_assignment_id;

  v_result := (true, 'ok', v_assignment_id, v_bin.id, v_bin.code);
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION assign_lot_to_bin(UUID, UUID, TEXT, TEXT) TO authenticated;

-- ============================================================================

DROP TYPE IF EXISTS confirm_pickup_result CASCADE;
CREATE TYPE confirm_pickup_result AS (
  ok BOOLEAN,
  reason TEXT,
  picked_up_count INTEGER,
  bin_id UUID,
  bin_code TEXT,
  lot_ids UUID[]
);

CREATE OR REPLACE FUNCTION confirm_pickup(p_bin_qr_token UUID)
RETURNS confirm_pickup_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_bin bins%ROWTYPE;
  v_lot_ids UUID[];
  v_count INTEGER := 0;
  v_result confirm_pickup_result;
BEGIN
  IF v_user IS NULL THEN
    v_result := (false, 'not_authenticated', 0, NULL, NULL, ARRAY[]::UUID[]);
    RETURN v_result;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM bidders WHERE id = v_user) THEN
    v_result := (false, 'not_a_bidder', 0, NULL, NULL, ARRAY[]::UUID[]);
    RETURN v_result;
  END IF;

  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found', 0, NULL, NULL, ARRAY[]::UUID[]);
    RETURN v_result;
  END IF;

  -- Find all staged bin_assignments at this bin for lots the bidder owns
  -- via a paid invoice. We use the latest staged assignment per lot.
  WITH latest_assignments AS (
    SELECT DISTINCT ON (ba.lot_id) ba.id, ba.lot_id, ba.status, ba.bin_id
    FROM bin_assignments ba
    WHERE ba.bin_id = v_bin.id
    ORDER BY ba.lot_id, ba.assigned_at DESC
  ),
  bidder_owned AS (
    SELECT la.id, la.lot_id
    FROM latest_assignments la
    JOIN invoice_lots il ON il.lot_id = la.lot_id
    JOIN invoices i ON i.id = il.invoice_id
    WHERE i.bidder_id = v_user
      AND i.status = 'paid'
      AND la.status = 'staged'
  ),
  picked AS (
    UPDATE bin_assignments
    SET status = 'picked_up', picked_up_at = now()
    WHERE id IN (SELECT id FROM bidder_owned)
    RETURNING lot_id
  )
  SELECT array_agg(lot_id), count(*) INTO v_lot_ids, v_count FROM picked;

  IF v_count = 0 THEN
    v_result := (false, 'no_staged_lots', 0, v_bin.id, v_bin.code, ARRAY[]::UUID[]);
    RETURN v_result;
  END IF;

  v_result := (true, 'ok', v_count, v_bin.id, v_bin.code, COALESCE(v_lot_ids, ARRAY[]::UUID[]));
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION confirm_pickup(UUID) TO authenticated;
