-- ============================================================================
-- Pickup slot computation + scheduling RPCs.
--
-- get_pickup_slots(invoice_id) returns available slots for the bidder to
-- choose from, based on:
--   - the auction's pickup_starts_at / pickup_ends_at
--   - the warehouse's pickup_hours JSONB schedule
--   - the warehouse's pickup_slot_minutes (slot duration)
--   - the warehouse's pickup_slot_capacity (max appointments per slot)
--   - existing pickups already scheduled in each slot
--
-- pickup_hours JSONB shape:
--   { "mon": [{"open":"10:00","close":"18:00"}], ... }
-- where keys are: mon, tue, wed, thu, fri, sat, sun.
--
-- schedule_pickup(invoice_id, slot_starts_at) atomically reserves a slot if
-- capacity remains; returns ok=false with reason='slot_full' otherwise.
-- ============================================================================

DROP TYPE IF EXISTS pickup_slot CASCADE;
CREATE TYPE pickup_slot AS (
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  remaining_capacity INTEGER
);

CREATE OR REPLACE FUNCTION get_pickup_slots(p_invoice_id UUID)
RETURNS SETOF pickup_slot
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_auction auctions%ROWTYPE;
  v_warehouse warehouses%ROWTYPE;
  v_window_start TIMESTAMPTZ;
  v_window_end TIMESTAMPTZ;
  v_slot_minutes INTEGER;
  v_capacity INTEGER;
  v_cursor TIMESTAMPTZ;
  v_day_key TEXT;
  v_local_time TIME;
  v_open TIME;
  v_close TIME;
  v_slot_taken INTEGER;
  v_hours JSONB;
  v_window JSONB;
BEGIN
  -- Auth: caller must own this invoice (or be operator staff for the owner)
  IF auth.uid() IS NULL THEN RETURN; END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_invoice.bidder_id <> auth.uid() AND
     v_invoice.operator_id <> current_operator_id() THEN
    RETURN;
  END IF;

  SELECT * INTO v_auction FROM auctions WHERE id = v_invoice.auction_id;
  SELECT * INTO v_warehouse FROM warehouses WHERE id = v_auction.warehouse_id;

  v_window_start := GREATEST(v_auction.pickup_starts_at, now());
  v_window_end := v_auction.pickup_ends_at;
  v_slot_minutes := v_warehouse.pickup_slot_minutes;
  v_capacity := v_warehouse.pickup_slot_capacity;
  v_hours := v_warehouse.pickup_hours;

  -- Empty pickup_hours means open continuously through the window.
  v_cursor := v_window_start;

  -- Round cursor up to nearest slot boundary
  v_cursor := date_trunc('hour', v_cursor) +
              (CEIL(EXTRACT(MINUTE FROM v_cursor) / v_slot_minutes::numeric) *
               (v_slot_minutes || ' minutes')::INTERVAL);

  WHILE v_cursor < v_window_end LOOP
    v_day_key := lower(to_char(v_cursor AT TIME ZONE COALESCE(v_warehouse.timezone, 'UTC'), 'dy'));
    v_local_time := (v_cursor AT TIME ZONE COALESCE(v_warehouse.timezone, 'UTC'))::TIME;

    -- If pickup_hours is set, gate by the day's open windows.
    IF v_hours <> '{}'::jsonb AND v_hours IS NOT NULL THEN
      v_window := v_hours -> v_day_key;
      IF v_window IS NULL OR jsonb_array_length(v_window) = 0 THEN
        v_cursor := v_cursor + (v_slot_minutes || ' minutes')::INTERVAL;
        CONTINUE;
      END IF;

      -- Check if v_local_time falls within ANY of today's windows
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_window) w
        WHERE v_local_time >= ((w->>'open')::TIME)
          AND v_local_time <  ((w->>'close')::TIME)
      ) THEN
        v_cursor := v_cursor + (v_slot_minutes || ' minutes')::INTERVAL;
        CONTINUE;
      END IF;
    END IF;

    -- Count how many pickups are already scheduled in this slot for this warehouse.
    SELECT count(*) INTO v_slot_taken
    FROM pickups p
    WHERE p.warehouse_id = v_warehouse.id
      AND p.scheduled_at >= v_cursor
      AND p.scheduled_at <  v_cursor + (v_slot_minutes || ' minutes')::INTERVAL
      AND p.status IN ('scheduled', 'pending');

    RETURN NEXT (
      v_cursor,
      v_cursor + (v_slot_minutes || ' minutes')::INTERVAL,
      GREATEST(0, v_capacity - v_slot_taken)
    )::pickup_slot;

    v_cursor := v_cursor + (v_slot_minutes || ' minutes')::INTERVAL;
  END LOOP;

  -- Open and close are referenced via NEW for the LSP; suppress unused warnings
  -- (the assignments are intentional even if unused in this code path).
  v_open := NULL;
  v_close := NULL;
  PERFORM v_open, v_close;
END;
$$;

GRANT EXECUTE ON FUNCTION get_pickup_slots(UUID) TO authenticated;

-- ============================================================================

DROP TYPE IF EXISTS schedule_pickup_result CASCADE;
CREATE TYPE schedule_pickup_result AS (
  ok BOOLEAN,
  reason TEXT,
  pickup_id UUID,
  scheduled_at TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION schedule_pickup(
  p_invoice_id UUID,
  p_slot_starts_at TIMESTAMPTZ
)
RETURNS schedule_pickup_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_invoice invoices%ROWTYPE;
  v_auction auctions%ROWTYPE;
  v_warehouse warehouses%ROWTYPE;
  v_pickup_id UUID;
  v_slot_taken INTEGER;
  v_slot_end TIMESTAMPTZ;
  v_result schedule_pickup_result;
BEGIN
  IF v_user IS NULL THEN
    v_result := (false, 'not_authenticated', NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND OR v_invoice.bidder_id <> v_user THEN
    v_result := (false, 'invoice_not_found', NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_invoice.status <> 'paid' THEN
    v_result := (false, 'invoice_not_paid', NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_auction FROM auctions WHERE id = v_invoice.auction_id;
  SELECT * INTO v_warehouse FROM warehouses WHERE id = v_auction.warehouse_id FOR UPDATE;

  v_slot_end := p_slot_starts_at + (v_warehouse.pickup_slot_minutes || ' minutes')::INTERVAL;

  IF p_slot_starts_at < v_auction.pickup_starts_at OR v_slot_end > v_auction.pickup_ends_at THEN
    v_result := (false, 'outside_pickup_window', NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT count(*) INTO v_slot_taken
  FROM pickups p
  WHERE p.warehouse_id = v_warehouse.id
    AND p.scheduled_at >= p_slot_starts_at
    AND p.scheduled_at <  v_slot_end
    AND p.status IN ('scheduled', 'pending')
    AND p.invoice_id <> p_invoice_id;

  IF v_slot_taken >= v_warehouse.pickup_slot_capacity THEN
    v_result := (false, 'slot_full', NULL, NULL);
    RETURN v_result;
  END IF;

  -- Upsert pickups row for this invoice.
  INSERT INTO pickups (invoice_id, warehouse_id, status, scheduled_at)
  VALUES (p_invoice_id, v_warehouse.id, 'scheduled', p_slot_starts_at)
  ON CONFLICT (invoice_id) DO UPDATE
    SET scheduled_at = EXCLUDED.scheduled_at,
        status = 'scheduled',
        updated_at = now()
  RETURNING id INTO v_pickup_id;

  v_result := (true, 'ok', v_pickup_id, p_slot_starts_at);
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION schedule_pickup(UUID, TIMESTAMPTZ) TO authenticated;

-- The pickups table needs a UNIQUE constraint on invoice_id for the upsert
-- above. Add it if it isn't there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pickups_invoice_id_unique'
  ) THEN
    ALTER TABLE pickups ADD CONSTRAINT pickups_invoice_id_unique UNIQUE (invoice_id);
  END IF;
END$$;
