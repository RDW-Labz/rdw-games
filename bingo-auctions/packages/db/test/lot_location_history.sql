-- lot_location_history (mig 0328) — every shelf across a relist chain.
--
-- Pins the report that produced 0328 (Jourdan Parker, 2026-08-18): "so many
-- relisted items not being found in the location it says they are in. It would
-- be nice if it showed us every location it's ever been on."
--
-- The case that matters is the RELIST: a relist mints a new lots row, so the
-- current location belongs to the newest generation while the box may still be
-- filed where an older one put it. A history that only covered the row in hand
-- would show exactly the location staff already knew was wrong.
--
-- Self-contained fixtures inside a ROLLBACKed transaction.

BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('e0000000-0000-0000-0000-0000000000f1', 'histtest', 'History Test Co',
        'hist@example.com', 'HST');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('e0000000-0000-0000-0000-0000000000f2', 'e0000000-0000-0000-0000-0000000000f1',
        'History WH', '1 Hist St', 'Harrison', 'AR', '72601');

-- lot_location_history resolves the caller via current_operator_id() /
-- auth.uid(), same as duplicate_lot's fixture does.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('e0000000-0000-0000-0000-0000000000f3', 'histstaff@example.com');
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('e0000000-0000-0000-0000-0000000000f1', 'e0000000-0000-0000-0000-0000000000f3',
        'manager', 'histstaff@example.com');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'e0000000-0000-0000-0000-0000000000f3'::uuid $$;

INSERT INTO bins (id, warehouse_id, code, aisle, bay, x_px, y_px, qr_token) VALUES
  ('e0000000-0000-0000-0000-0000000000b1', 'e0000000-0000-0000-0000-0000000000f2', '1-01-01', '1', '01', 0, 0, 'e0000000-0000-0000-0000-0000000000c1'),
  ('e0000000-0000-0000-0000-0000000000b2', 'e0000000-0000-0000-0000-0000000000f2', '2-02-02', '2', '02', 0, 0, 'e0000000-0000-0000-0000-0000000000c2');

-- Generation 1: put away on 1-01-01 a month ago, then closed unsold.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title, condition,
                  msrp_cents, starting_bid_cents, intake_bin_id, intake_at, created_at)
VALUES ('e0000000-0000-0000-0000-00000000a001', 'e0000000-0000-0000-0000-0000000000f1',
        'e0000000-0000-0000-0000-0000000000f2', 'HIST-GEN1', 'unsold', 'Wandering Kettle',
        'good', 4999, 500, 'e0000000-0000-0000-0000-0000000000b1',
        now() - interval '30 days', now() - interval '31 days');

-- Generation 2: the relist. New row, new shelf on the record.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title, condition,
                  msrp_cents, starting_bid_cents, intake_bin_id, intake_at, created_at,
                  relisted_from_lot_id)
VALUES ('e0000000-0000-0000-0000-00000000a002', 'e0000000-0000-0000-0000-0000000000f1',
        'e0000000-0000-0000-0000-0000000000f2', 'HIST-GEN2', 'in_inventory', 'Wandering Kettle',
        'good', 4999, 500, 'e0000000-0000-0000-0000-0000000000b2',
        now() - interval '2 days', now() - interval '2 days',
        'e0000000-0000-0000-0000-00000000a001');

-- ---------------------------------------------------------------------------
-- The trigger logs a move the moment a shelf changes.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_count INT;
BEGIN
  -- Both inserts above carried a bin, so both should have logged one 'intake'.
  SELECT count(*) INTO v_count
  FROM lot_location_events
  WHERE lot_id IN ('e0000000-0000-0000-0000-00000000a001',
                   'e0000000-0000-0000-0000-00000000a002');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected 2 logged intakes from the inserts, got %', v_count;
  END IF;

  -- A move logs another. This is the trigger's whole reason for existing: it
  -- fires for ANY writer, including RPCs that do not know the log exists.
  UPDATE lots SET intake_bin_id = 'e0000000-0000-0000-0000-0000000000b1'
  WHERE id = 'e0000000-0000-0000-0000-00000000a002';

  SELECT count(*) INTO v_count
  FROM lot_location_events
  WHERE lot_id = 'e0000000-0000-0000-0000-00000000a002';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'a shelf change did not log a move (have % events)', v_count;
  END IF;

  -- A no-op write must NOT log. Otherwise any bulk UPDATE over lots floods the
  -- history with entries for boxes that never moved.
  UPDATE lots SET intake_bin_id = 'e0000000-0000-0000-0000-0000000000b1'
  WHERE id = 'e0000000-0000-0000-0000-00000000a002';

  SELECT count(*) INTO v_count
  FROM lot_location_events
  WHERE lot_id = 'e0000000-0000-0000-0000-00000000a002';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'a no-op update logged a phantom move (have % events)', v_count;
  END IF;

  RAISE NOTICE 'lot_location_events: logs real moves, ignores no-ops OK';
END $$;

-- ---------------------------------------------------------------------------
-- The reader crosses the relist boundary — in both directions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_gen1  INT;
  v_gen2  INT;
  v_fail  TEXT := '';
BEGIN
  -- Scanning the NEWEST generation must still surface the ancestor's shelf,
  -- which is where the box may actually be sitting.
  SELECT count(*) INTO v_gen1
  FROM lot_location_history('e0000000-0000-0000-0000-00000000a002')
  WHERE lot_code = 'HIST-GEN1';
  IF v_gen1 = 0 THEN
    v_fail := v_fail || E'\n  scanning gen2 did not surface gen1 history';
  END IF;

  -- And scanning the OLD sticker must reach forward to the current generation:
  -- a picker holding a box can land on either label.
  SELECT count(*) INTO v_gen2
  FROM lot_location_history('e0000000-0000-0000-0000-00000000a001')
  WHERE lot_code = 'HIST-GEN2';
  IF v_gen2 = 0 THEN
    v_fail := v_fail || E'\n  scanning gen1 did not reach forward to gen2 history';
  END IF;

  -- Exactly one row may claim to be current, or the screen has two answers.
  IF (SELECT count(*) FROM lot_location_history('e0000000-0000-0000-0000-00000000a002')
      WHERE is_current) <> 1 THEN
    v_fail := v_fail || E'\n  is_current is not exactly one row';
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'lot_location_history FAILURES:%', v_fail;
  END IF;
  RAISE NOTICE 'lot_location_history: walks the relist chain both ways OK';
END $$;

ROLLBACK;
