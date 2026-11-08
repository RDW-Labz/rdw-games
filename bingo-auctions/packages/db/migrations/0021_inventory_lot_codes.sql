-- ============================================================================
-- Inventory model + app-wide unique lot codes.
--
-- Architectural shift: lots no longer have to belong to an auction
-- when they're written. The lifecycle becomes:
--
--   1. Manifest import → lots row (status='pending_intake',
--      auction_id=NULL). The manifest is intent — operator doesn't
--      know yet which items will actually arrive.
--   2. Truck arrives, picker scans item into a bin → status flips to
--      'in_inventory', intake_bin_id set. This is the first moment
--      the lot is "real."
--   3. Operator runs the Auction Builder UI to select N inventory
--      items for an auction → auction_id + lot_number get set,
--      status becomes 'scheduled'. Existing place_bid /
--      finalize_lot / RLS continue to work unchanged because they
--      filter on status.
--
-- Plus: every lot gets an app-wide unique human-readable code,
-- prefixed with the operator's 3-5 char abbreviation. Codes look
-- like "RDW-000001" / "CLR-000087". Operators see their prefix on
-- every label they print; bidders see it on cards and receipts.
-- Codes are atomic-incremented from operators.next_lot_seq.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Operators get an abbreviation + a per-operator lot sequence.
-- ----------------------------------------------------------------------------

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS code TEXT,
  ADD COLUMN IF NOT EXISTS next_lot_seq BIGINT NOT NULL DEFAULT 1;

-- Backfill existing operators. Pull a deterministic 3-char code from
-- business_name first letters, falling back to slug. Anything that
-- collides we resolve by appending a digit.
DO $$
DECLARE
  r RECORD;
  candidate TEXT;
  suffix INT;
BEGIN
  FOR r IN SELECT id, slug, business_name FROM operators WHERE code IS NULL LOOP
    candidate := UPPER(
      regexp_replace(
        coalesce(r.business_name, r.slug),
        '[^A-Za-z0-9]+', '', 'g'
      )
    );
    candidate := substring(candidate from 1 for 3);
    IF length(candidate) < 2 THEN
      candidate := UPPER(substring(coalesce(r.slug, 'OP') from 1 for 3));
    END IF;
    suffix := 0;
    WHILE EXISTS (SELECT 1 FROM operators WHERE code = candidate) LOOP
      suffix := suffix + 1;
      candidate := substring(candidate from 1 for 3) || suffix::TEXT;
    END LOOP;
    UPDATE operators SET code = candidate WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE operators
  ALTER COLUMN code SET NOT NULL;
ALTER TABLE operators
  ADD CONSTRAINT operators_code_unique UNIQUE (code);
ALTER TABLE operators
  ADD CONSTRAINT operators_code_format CHECK (code ~ '^[A-Z0-9]{2,8}$');

-- ----------------------------------------------------------------------------
-- New lot statuses.
--   pending_intake — manifest record, item not yet physically present
--   in_inventory   — scanned to a bin, available to add to an auction
-- Both have auction_id NULL by definition.
-- ----------------------------------------------------------------------------

ALTER TYPE lot_status ADD VALUE IF NOT EXISTS 'pending_intake';
ALTER TYPE lot_status ADD VALUE IF NOT EXISTS 'in_inventory';

-- ----------------------------------------------------------------------------
-- Lots: app-wide unique code, nullable auction membership, intake bin.
-- ----------------------------------------------------------------------------

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS lot_code TEXT,
  ADD COLUMN IF NOT EXISTS intake_bin_id UUID REFERENCES bins(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS intake_at TIMESTAMPTZ;

-- Drop the strict NOT NULLs that prevented inventory state.
ALTER TABLE lots ALTER COLUMN auction_id DROP NOT NULL;
ALTER TABLE lots ALTER COLUMN lot_number DROP NOT NULL;
ALTER TABLE lots ALTER COLUMN warehouse_id DROP NOT NULL;
ALTER TABLE lots ALTER COLUMN close_at DROP NOT NULL;

-- A lot in an auction MUST have an auction-specific number, but
-- inventory lots haven't been numbered yet. Replace the old UNIQUE
-- (auction_id, lot_number) constraint with a partial unique index
-- that only applies when both are set.
ALTER TABLE lots DROP CONSTRAINT IF EXISTS lots_auction_id_lot_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS lots_auction_lot_number_unique
  ON lots (auction_id, lot_number)
  WHERE auction_id IS NOT NULL AND lot_number IS NOT NULL;

-- App-wide uniqueness on lot_code.
CREATE UNIQUE INDEX IF NOT EXISTS lots_lot_code_unique
  ON lots (lot_code)
  WHERE lot_code IS NOT NULL;

-- Helpful index for the new Inventory page on the operator side.
CREATE INDEX IF NOT EXISTS lots_inventory_idx
  ON lots (operator_id, status)
  WHERE auction_id IS NULL;

-- ----------------------------------------------------------------------------
-- Code generator. SECURITY DEFINER + row-level locking on the
-- operator row so two concurrent inserts can't grab the same seq.
-- Returns the formatted code; callers UPDATE lots.lot_code with it.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION next_lot_code(p_operator_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq BIGINT;
  v_code TEXT;
BEGIN
  -- Atomic increment with row lock. The UPDATE returns the
  -- pre-increment seq, so we use that for the code.
  UPDATE operators
  SET next_lot_seq = next_lot_seq + 1
  WHERE id = p_operator_id
  RETURNING code, next_lot_seq - 1 INTO v_code, v_seq;

  IF v_code IS NULL THEN
    RAISE EXCEPTION 'operator % not found', p_operator_id;
  END IF;
  RETURN v_code || '-' || lpad(v_seq::TEXT, 6, '0');
END;
$$;

REVOKE ALL ON FUNCTION next_lot_code(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION next_lot_code(UUID) TO authenticated;

-- ----------------------------------------------------------------------------
-- Backfill existing lots. Each gets a code from its operator's seq.
-- Order by created_at so codes match historical creation order.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  r RECORD;
  c TEXT;
BEGIN
  FOR r IN SELECT id, operator_id FROM lots WHERE lot_code IS NULL ORDER BY created_at LOOP
    c := next_lot_code(r.operator_id);
    UPDATE lots SET lot_code = c WHERE id = r.id;
  END LOOP;
END $$;

-- After backfill, lot_code becomes required.
ALTER TABLE lots ALTER COLUMN lot_code SET NOT NULL;
