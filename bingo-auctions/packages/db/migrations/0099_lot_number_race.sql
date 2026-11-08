-- ============================================================================
-- Migration 0099 — Atomic lot_number assignment
--
-- Background (docs/auction-lot-audit-plan.md, BUG-LL-02 + BUG-ARCH-06 race):
--   Three code paths assign lot_number by reading MAX(lot_number) and
--   adding 1 in JavaScript before INSERT:
--     - lots/new/actions.ts createLot
--     - lots/import/actions.ts importLotsCsv
--     - relist_lot_into_auction (added in migration 0097)
--   Under concurrent inserts these can collide on the same lot_number.
--
-- This migration:
--   1. Adds a partial UNIQUE constraint on (auction_id, lot_number) WHERE
--      both are NOT NULL. Bins the database-level race window — concurrent
--      inserts get 23505 unique_violation instead of silent duplicates.
--   2. Updates relist_lot_into_auction to take an advisory lock on the
--      auction id BEFORE computing MAX, so concurrent relist (manual +
--      auto) calls on the same target auction serialize.
--   3. Exposes reserve_next_lot_number(auction_id) as a SECURITY DEFINER
--      RPC for app-code callers (createLot, importLotsCsv) — same
--      advisory-lock pattern.
--
-- App-code path (createLot, importLotsCsv) is updated in a follow-up
-- commit. Pre-existing lots aren't impacted by the new UNIQUE — partial
-- WHERE clause handles the NULL-lot_number inventory rows.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. UNIQUE backstop
-- ---------------------------------------------------------------------------

-- Partial: only enforce uniqueness when both columns are NOT NULL.
-- Inventory-only lots (auction_id IS NULL) and any legacy lot_number=NULL
-- rows are unaffected. New in-auction lots get the guarantee.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lots_auction_lot_number_uniq'
  ) THEN
    -- Check for existing dupes first. Safer to surface than to error mid-
    -- migration. The query is cheap (single index scan on auction_lot_number).
    IF EXISTS (
      SELECT 1
      FROM lots
      WHERE auction_id IS NOT NULL AND lot_number IS NOT NULL
      GROUP BY auction_id, lot_number
      HAVING count(*) > 1
    ) THEN
      RAISE NOTICE 'lots has duplicate (auction_id, lot_number) rows — UNIQUE constraint skipped. Investigate before re-running.';
    ELSE
      -- Partial UNIQUE via index since CHECK doesn't support uniqueness.
      CREATE UNIQUE INDEX lots_auction_lot_number_uniq
        ON lots (auction_id, lot_number)
        WHERE auction_id IS NOT NULL AND lot_number IS NOT NULL;
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. reserve_next_lot_number(auction_id) RPC
-- ---------------------------------------------------------------------------
-- Returns the next available lot_number for the target auction, while
-- holding an advisory lock for the duration of the calling transaction.
-- This prevents the classic read-then-insert race so long as the caller
-- INSERTs within the same transaction (Supabase RPC calls satisfy this).
--
-- For batch operations (importLotsCsv inserts N at a time), call
-- reserve_lot_number_range(auction_id, count) below instead — it
-- reserves a contiguous range under the same lock.

CREATE OR REPLACE FUNCTION reserve_next_lot_number(p_auction_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next INT;
BEGIN
  -- Advisory lock keyed on a hash of the auction id. pg_advisory_xact_lock
  -- releases on COMMIT/ROLLBACK so the lock lifetime tracks the caller's
  -- transaction. The hash function is stable, so two RPCs racing on the
  -- same auction_id contend for the same lock id.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_auction_id::TEXT, 0));

  SELECT COALESCE(MAX(lot_number), 0) + 1 INTO v_next
    FROM lots
   WHERE auction_id = p_auction_id;

  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION reserve_next_lot_number(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_next_lot_number(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION reserve_lot_number_range(
  p_auction_id UUID,
  p_count      INT
)
RETURNS INT  -- returns the FIRST number; caller emits [first, first+count-1]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_first INT;
BEGIN
  IF p_count < 1 OR p_count > 10000 THEN
    RAISE EXCEPTION 'invalid_count: %', p_count USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_auction_id::TEXT, 0));
  SELECT COALESCE(MAX(lot_number), 0) + 1 INTO v_first
    FROM lots WHERE auction_id = p_auction_id;
  RETURN v_first;
END;
$$;

REVOKE ALL ON FUNCTION reserve_lot_number_range(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_lot_number_range(UUID, INT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Patch relist_lot_into_auction to hold the lock too
-- ---------------------------------------------------------------------------
-- Same body as migration 0097 except the lot-number computation now sits
-- inside the advisory lock. Concurrent relist + auto-relist calls on the
-- same target auction serialize cleanly.

CREATE OR REPLACE FUNCTION relist_lot_into_auction(
  p_lot_id     UUID,
  p_auction_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src        lots%ROWTYPE;
  v_auction    auctions%ROWTYPE;
  v_new_code   TEXT;
  v_new_lot_id UUID;
  v_lot_number INT;
  v_op_id      UUID;
BEGIN
  SELECT * INTO v_src FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_src.id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_src.status NOT IN ('unsold', 'in_inventory', 'relisted') THEN
    RAISE EXCEPTION 'relist_source_wrong_status: %', v_src.status
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_auction FROM auctions WHERE id = p_auction_id;
  IF v_auction.id IS NULL THEN
    RAISE EXCEPTION 'relist_target_auction_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_auction.operator_id <> v_src.operator_id THEN
    RAISE EXCEPTION 'relist_cross_tenant' USING ERRCODE = '42501';
  END IF;
  IF v_auction.warehouse_id <> v_src.warehouse_id THEN
    RAISE EXCEPTION 'relist_target_different_warehouse' USING ERRCODE = 'P0001';
  END IF;
  IF v_auction.status NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'relist_target_wrong_status: %', v_auction.status
      USING ERRCODE = 'P0001';
  END IF;

  v_op_id := v_src.operator_id;

  SELECT next_lot_code(v_op_id) INTO v_new_code;
  IF v_new_code IS NULL THEN
    RAISE EXCEPTION 'relist_lot_code_mint_failed' USING ERRCODE = 'P0001';
  END IF;

  -- 0099 fix: take the advisory lock for the auction BEFORE computing
  -- the next lot_number. Concurrent relist attempts (manual + auto) on
  -- the same target auction serialize here instead of racing on MAX+1.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_auction_id::TEXT, 0));

  SELECT COALESCE(MAX(lot_number), 0) + 1 INTO v_lot_number
  FROM lots WHERE auction_id = p_auction_id;

  INSERT INTO lots (
    operator_id, auction_id, warehouse_id,
    lot_code, lot_number,
    title, description, category, condition,
    msrp_cents, starting_bid_cents, photo_urls,
    close_at, status,
    relisted_from_lot_id, relist_count, last_relisted_at,
    source, external_code,
    intake_at, intake_bin_id
  )
  VALUES (
    v_op_id, p_auction_id, v_src.warehouse_id,
    v_new_code, v_lot_number,
    v_src.title, v_src.description, v_src.category, v_src.condition,
    v_src.msrp_cents, v_src.starting_bid_cents, COALESCE(v_src.photo_urls, '{}'::TEXT[]),
    v_auction.ends_at, 'draft',
    v_src.id, COALESCE(v_src.relist_count, 0) + 1, now(),
    v_src.source, v_src.external_code,
    v_src.intake_at, v_src.intake_bin_id
  )
  RETURNING id INTO v_new_lot_id;

  UPDATE lots
  SET status = 'relisted',
      last_relisted_at = now(),
      updated_at = now()
  WHERE id = p_lot_id;

  RETURN v_new_lot_id;
END;
$$;

REVOKE ALL ON FUNCTION relist_lot_into_auction(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relist_lot_into_auction(UUID, UUID) TO authenticated;

COMMIT;
