-- ============================================================================
-- Notifications outbox + pickup scheduling support.
--
-- Outbox pattern: SQL functions that mutate state (place_bid, finalize_lot,
-- assign_lot_to_bin) write to notifications_outbox in the same transaction.
-- An auction-engine worker drains this table and pushes via Expo Push API.
-- This avoids fragile DB triggers calling out to HTTP, and is exactly-once
-- delivery (worker marks processed_at; rows with processed_at IS NOT NULL
-- are ignored).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Bidders: Expo push token
-- ----------------------------------------------------------------------------

ALTER TABLE bidders ADD COLUMN IF NOT EXISTS expo_push_token TEXT;
ALTER TABLE bidders ADD COLUMN IF NOT EXISTS push_registered_at TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
-- Warehouses: pickup slot configuration
-- ----------------------------------------------------------------------------

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS pickup_slot_minutes INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS pickup_slot_capacity INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS entrance_x_px INTEGER,
  ADD COLUMN IF NOT EXISTS entrance_y_px INTEGER;

-- ----------------------------------------------------------------------------
-- Notifications outbox
-- ----------------------------------------------------------------------------

CREATE TYPE notification_kind AS ENUM (
  'outbid',
  'won',
  'pickup_ready',
  'pickup_confirmed',
  'dispute_update'
);

CREATE TABLE notifications_outbox (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind notification_kind NOT NULL,
  -- Target user — usually a bidder, sometimes an operator_user
  target_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Idempotency key prevents duplicate sends; jobs are upserted by this key
  -- when the same logical event fires twice (e.g., picker re-stages a lot).
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX notifications_outbox_unprocessed_idx
  ON notifications_outbox (created_at)
  WHERE processed_at IS NULL;

-- The worker reads this table with the service role; we still enable RLS so
-- end-user clients can't see other users' notifications.
ALTER TABLE notifications_outbox ENABLE ROW LEVEL SECURITY;
-- (No SELECT/INSERT policies for end users — only service role touches this.)

-- ----------------------------------------------------------------------------
-- Helper: enqueue a notification from inside a SECURITY DEFINER function.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enqueue_notification(
  p_kind notification_kind,
  p_target_user_id UUID,
  p_payload JSONB,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO notifications_outbox (kind, target_user_id, payload, idempotency_key)
  VALUES (p_kind, p_target_user_id, p_payload, p_idempotency_key)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id;
$$;

-- ----------------------------------------------------------------------------
-- Patch place_bid: enqueue 'outbid' notification when applicable.
--
-- We do this by REPLACING the function. The body is identical to 0003 with
-- one new block at the end before the RETURN.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION place_bid(
  p_lot_id UUID,
  p_max_amount_cents BIGINT
)
RETURNS place_bid_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bidder_id UUID := auth.uid();
  v_lot lots%ROWTYPE;
  v_auction auctions%ROWTYPE;
  v_min_increment BIGINT;
  v_current_max_bid bids%ROWTYPE;
  v_new_current_cents BIGINT;
  v_leader_id UUID;
  v_new_bid_id UUID;
  v_auto_bid_id UUID;
  v_was_extended BOOLEAN := false;
  v_outbid_bidder_id UUID;
  v_result place_bid_result;
BEGIN
  IF v_bidder_id IS NULL THEN
    v_result := (false, 'not_authenticated', p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM bidders WHERE id = v_bidder_id) THEN
    v_result := (false, 'not_a_bidder', p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF NOT FOUND THEN
    v_result := (false, 'lot_not_found', p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.status NOT IN ('scheduled', 'live') THEN
    v_result := (false, 'lot_not_biddable', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;
  IF now() >= v_lot.close_at THEN
    v_result := (false, 'lot_closed', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  v_min_increment := min_bid_increment_cents(v_lot.current_bid_cents);

  IF v_lot.current_bid_cents IS NULL THEN
    IF p_max_amount_cents < v_lot.starting_bid_cents THEN
      v_result := (false, 'below_starting_bid', p_lot_id, v_lot.current_bid_cents,
                   NULL, v_lot.close_at, false, NULL);
      RETURN v_result;
    END IF;
  ELSE
    IF p_max_amount_cents < v_lot.current_bid_cents + v_min_increment THEN
      v_result := (false, 'below_min_increment', p_lot_id, v_lot.current_bid_cents,
                   v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
      RETURN v_result;
    END IF;
  END IF;

  SELECT b.* INTO v_current_max_bid
  FROM bids b
  WHERE b.lot_id = p_lot_id AND b.bidder_id = v_lot.winner_bidder_id
  ORDER BY b.placed_at DESC
  LIMIT 1;

  IF v_lot.winner_bidder_id IS NULL THEN
    v_new_current_cents := v_lot.starting_bid_cents;
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := NULL;
  ELSIF v_lot.winner_bidder_id = v_bidder_id THEN
    v_new_current_cents := v_lot.current_bid_cents;
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := NULL;
  ELSIF p_max_amount_cents > v_current_max_bid.max_amount_cents THEN
    v_new_current_cents := LEAST(
      p_max_amount_cents,
      v_current_max_bid.max_amount_cents + v_min_increment
    );
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := v_lot.winner_bidder_id;
  ELSE
    v_new_current_cents := LEAST(
      v_current_max_bid.max_amount_cents,
      p_max_amount_cents + v_min_increment
    );
    v_leader_id := v_lot.winner_bidder_id;
    v_outbid_bidder_id := v_bidder_id;
  END IF;

  INSERT INTO bids (lot_id, bidder_id, amount_cents, max_amount_cents, is_auto)
  VALUES (
    p_lot_id, v_bidder_id,
    CASE WHEN v_leader_id = v_bidder_id THEN v_new_current_cents
         ELSE p_max_amount_cents END,
    p_max_amount_cents,
    false
  )
  RETURNING id INTO v_new_bid_id;

  IF v_leader_id <> v_bidder_id AND v_lot.winner_bidder_id IS NOT NULL THEN
    INSERT INTO bids (lot_id, bidder_id, amount_cents, max_amount_cents, is_auto)
    VALUES (
      p_lot_id,
      v_lot.winner_bidder_id,
      v_new_current_cents,
      v_current_max_bid.max_amount_cents,
      true
    )
    RETURNING id INTO v_auto_bid_id;
  END IF;

  SELECT * INTO v_auction FROM auctions WHERE id = v_lot.auction_id;
  IF v_auction.soft_close_minutes > 0 AND
     v_lot.close_at - now() < make_interval(mins => v_auction.soft_close_minutes) THEN
    v_lot.close_at := now() + make_interval(mins => v_auction.soft_close_minutes);
    v_was_extended := true;
  END IF;

  UPDATE lots SET
    current_bid_cents = v_new_current_cents,
    current_bid_id = COALESCE(v_auto_bid_id, v_new_bid_id),
    winner_bidder_id = v_leader_id,
    bid_count = bid_count + CASE WHEN v_auto_bid_id IS NOT NULL THEN 2 ELSE 1 END,
    close_at = v_lot.close_at,
    status = CASE WHEN status = 'scheduled' THEN 'live' ELSE status END,
    updated_at = now()
  WHERE id = p_lot_id;

  -- NEW: enqueue outbid notification when a bidder is bumped down.
  IF v_outbid_bidder_id IS NOT NULL THEN
    PERFORM enqueue_notification(
      'outbid',
      v_outbid_bidder_id,
      jsonb_build_object(
        'lot_id', p_lot_id,
        'lot_title', v_lot.title,
        'current_bid_cents', v_new_current_cents
      ),
      -- One outbid push per (bidder, lot, current_price) — re-bidding at
      -- the same price won't re-fire.
      'outbid:' || v_outbid_bidder_id || ':' || p_lot_id || ':' || v_new_current_cents::TEXT
    );
  END IF;

  v_result := (true, 'ok', p_lot_id, v_new_current_cents, v_leader_id,
               v_lot.close_at, v_was_extended, v_outbid_bidder_id);
  RETURN v_result;
END;
$$;

-- ----------------------------------------------------------------------------
-- Patch finalize_lot: enqueue 'won' notification.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION finalize_lot(p_lot_id UUID)
RETURNS finalize_lot_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot lots%ROWTYPE;
  v_result finalize_lot_result;
BEGIN
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;

  IF NOT FOUND THEN
    v_result := (false, 'lot_not_found', p_lot_id, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  IF v_lot.status IN ('won', 'unsold', 'canceled') THEN
    v_result := (true, 'already_closed', p_lot_id, v_lot.status, v_lot.close_at,
                 v_lot.winner_bidder_id, v_lot.current_bid_cents);
    RETURN v_result;
  END IF;

  IF now() < v_lot.close_at THEN
    v_result := (false, 'reschedule', p_lot_id, v_lot.status, v_lot.close_at,
                 v_lot.winner_bidder_id, v_lot.current_bid_cents);
    RETURN v_result;
  END IF;

  IF v_lot.winner_bidder_id IS NOT NULL THEN
    UPDATE lots SET status = 'won', closed_at = now(), updated_at = now() WHERE id = p_lot_id;

    PERFORM enqueue_notification(
      'won',
      v_lot.winner_bidder_id,
      jsonb_build_object(
        'lot_id', p_lot_id,
        'lot_title', v_lot.title,
        'winning_bid_cents', v_lot.current_bid_cents,
        'auction_id', v_lot.auction_id
      ),
      'won:' || v_lot.winner_bidder_id || ':' || p_lot_id
    );

    v_result := (true, 'won', p_lot_id, 'won'::lot_status, v_lot.close_at,
                 v_lot.winner_bidder_id, v_lot.current_bid_cents);
  ELSE
    UPDATE lots SET status = 'unsold', closed_at = now(), updated_at = now() WHERE id = p_lot_id;
    v_result := (true, 'unsold', p_lot_id, 'unsold'::lot_status, v_lot.close_at, NULL, NULL);
  END IF;

  RETURN v_result;
END;
$$;

-- ----------------------------------------------------------------------------
-- Patch assign_lot_to_bin: enqueue 'pickup_ready' if all of an invoice's
-- lots are now staged. We loop over the invoices that contain this lot and
-- fire one notification per fully-staged invoice (idempotent via key).
-- ----------------------------------------------------------------------------

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

  -- For each invoice this lot belongs to, check whether ALL its lots now
  -- have a 'staged' assignment. If so, emit a single pickup_ready push to
  -- the bidder. Idempotent via key including invoice id.
  FOR v_invoice_record IN
    SELECT i.id AS invoice_id, i.bidder_id
    FROM invoice_lots il
    JOIN invoices i ON i.id = il.invoice_id
    WHERE il.lot_id = p_lot_id AND i.status = 'paid'
  LOOP
    -- Are all lots in this invoice staged?
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
