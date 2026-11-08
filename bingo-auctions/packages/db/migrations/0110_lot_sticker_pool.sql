-- ============================================================================
-- Migration 0110 — Pre-stickered lotting mode.
--
-- ClovrBid's lotting flow now supports two modes:
--
--   Generate (existing, default):
--     1. AI-lot the item (photo + AI fill creates a lots row with an
--        auto-generated qr_token)
--     2. Operator prints the sticker via /api/lots/qr-sheet
--     3. Stick on the physical item
--     4. Scan lot QR + bin QR for put-away
--
--   Pre-stickered (NEW):
--     1. Operator pre-prints a roll of generic UUID stickers via the new
--        /api/lots/blank-qr-sheet route (a batch of N blank stickers,
--        each encoding https://clovrbid.com/l/{random-uuid}). The UUIDs
--        get parked in lot_sticker_pool (claimed_at = NULL).
--     2. AI-lot the item (lots row created with auto-gen qr_token)
--     3. Operator scans a pre-printed sticker — claim_prestickered_qr()
--        rotates the lot's qr_token to the scanned UUID and marks the
--        pool row claimed.
--     4. Sticker goes on the physical item.
--     5. Scan lot QR + bin QR for put-away — same as Generate mode.
--
-- Why two modes:
--   - Generate is easier when the operator has on-demand printing at the
--     warehouse (Brother label printer + AirPrint or our /api/lots/qr-sheet
--     PDF).
--   - Pre-stickered fits the BidFTA-style workflow where operators buy a
--     roll of generic numbered/QR stickers and stick before lotting. No
--     printer-at-the-warehouse requirement.
--
-- ADDITIVE ONLY. lots.qr_token (from 0103) is the existing target column
-- both modes write to. The pool table is an audit + uniqueness layer.
-- Pre-stickered mode also works WITHOUT the pool — operators can scan
-- any UUID and it'll be accepted (claim_prestickered_qr handles that
-- gracefully). The pool just makes "blank sheet" printing deterministic
-- + lets us show "X unclaimed stickers" in the operator console.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. lot_sticker_pool — pre-minted UUIDs ready to be assigned to lots
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lot_sticker_pool (
  qr_token            UUID PRIMARY KEY,
  operator_id         UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  -- Groups stickers that were printed together. Useful for "rollback this
  -- batch" if the operator printed a sheet and lost it.
  printed_batch_id    UUID NOT NULL,
  printed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  printed_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- NULL until the sticker is scanned during pre-stickered lotting.
  claimed_at          TIMESTAMPTZ,
  claimed_by_lot_id   UUID REFERENCES lots(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS lot_sticker_pool_operator_unclaimed_idx
  ON lot_sticker_pool (operator_id, printed_at DESC)
  WHERE claimed_at IS NULL;

CREATE INDEX IF NOT EXISTS lot_sticker_pool_batch_idx
  ON lot_sticker_pool (printed_batch_id);

ALTER TABLE lot_sticker_pool ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lot_sticker_pool_operator_all ON lot_sticker_pool;
CREATE POLICY lot_sticker_pool_operator_all
  ON lot_sticker_pool FOR ALL
  USING (operator_id = current_operator_id())
  WITH CHECK (operator_id = current_operator_id());

-- ---------------------------------------------------------------------------
-- 2. mint_blank_qr_batch — operator console route mints N pool rows
-- ---------------------------------------------------------------------------
-- Called by /api/lots/blank-qr-sheet. Generates N random UUIDs scoped to
-- the caller's operator, inserts them into the pool, and returns the
-- batch_id so the route can render exactly those UUIDs into a PDF.
--
-- Cap of 500 per call to keep PDF render time bounded.

CREATE OR REPLACE FUNCTION mint_blank_qr_batch(
  p_count INTEGER DEFAULT 50
)
RETURNS TABLE (
  batch_id  UUID,
  qr_tokens UUID[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id    UUID;
  v_batch_id UUID := uuid_generate_v4();
  v_tokens   UUID[] := ARRAY[]::UUID[];
  v_token    UUID;
  i INTEGER;
BEGIN
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;
  IF p_count < 1 OR p_count > 500 THEN
    RAISE EXCEPTION 'invalid_count: 1-500 only' USING ERRCODE = 'P0001';
  END IF;

  FOR i IN 1..p_count LOOP
    v_token := uuid_generate_v4();
    INSERT INTO lot_sticker_pool
      (qr_token, operator_id, printed_batch_id, printed_by)
    VALUES
      (v_token, v_op_id, v_batch_id, auth.uid());
    v_tokens := v_tokens || v_token;
  END LOOP;

  RETURN QUERY SELECT v_batch_id, v_tokens;
END;
$$;

REVOKE ALL ON FUNCTION mint_blank_qr_batch(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mint_blank_qr_batch(INTEGER) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. claim_prestickered_qr — rotate lot.qr_token to a scanned UUID
-- ---------------------------------------------------------------------------
-- Called by field-mobile after a successful AI-lot when the operator
-- chose pre-stickered mode and scanned the sticker.
--
-- Validates:
--   - caller is operator staff
--   - lot belongs to caller's operator
--   - the new token isn't already used by another lot (uniqueness on
--     lots.qr_token from 0103)
--
-- Side effects:
--   - UPDATE lots SET qr_token = p_qr_token, qr_rotated_at = now()
--   - If the new token is in lot_sticker_pool (caller's operator + not
--     already claimed) → mark claimed. Optional — works fine without
--     a pool row (optimistic mode).
--
-- Returns jsonb so the field-mobile UI can branch on outcome.

CREATE OR REPLACE FUNCTION claim_prestickered_qr(
  p_lot_id   UUID,
  p_qr_token UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id      UUID;
  v_lot        lots%ROWTYPE;
  v_other_lot  UUID;
BEGIN
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id;
  IF v_lot.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_other_operator');
  END IF;

  -- Already pointing at this token? Idempotent success.
  IF v_lot.qr_token = p_qr_token THEN
    RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id,
      'qr_token', p_qr_token, 'idempotent', true);
  END IF;

  -- Token used by another lot? Reject.
  SELECT id INTO v_other_lot
    FROM lots WHERE qr_token = p_qr_token AND id <> p_lot_id
    LIMIT 1;
  IF v_other_lot IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'qr_token_already_used',
      'other_lot_id', v_other_lot
    );
  END IF;

  -- Mark pool row claimed if it exists.
  UPDATE lot_sticker_pool
     SET claimed_at = now(),
         claimed_by_lot_id = p_lot_id
   WHERE qr_token = p_qr_token
     AND operator_id = v_op_id
     AND claimed_at IS NULL;

  -- Rotate the lot's qr_token.
  UPDATE lots
     SET qr_token = p_qr_token,
         qr_rotated_at = now(),
         updated_at = now()
   WHERE id = p_lot_id;

  RETURN jsonb_build_object(
    'ok', true,
    'lot_id', p_lot_id,
    'qr_token', p_qr_token,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION claim_prestickered_qr(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_prestickered_qr(UUID, UUID) TO authenticated;
