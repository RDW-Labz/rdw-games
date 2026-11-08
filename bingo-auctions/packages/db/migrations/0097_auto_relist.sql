-- ============================================================================
-- Migration 0097 — Auto-relist unsold lots
--
-- User request: "I like to run unsold lots twice before I pull them and get
-- rid of them another way. We want this to be an operator setting. Staff
-- needs visibility into relist state."
--
-- Model:
--   - Operator level: auto_relist_enabled (bool), auto_relist_max_attempts
--     (int, default 2 — meaning a lot gets 2 additional auction listings
--     after the original before manual review).
--   - Lot level: relist_count (how many times it's been relisted),
--     relisted_from_lot_id (lineage — points at the previous incarnation),
--     last_relisted_at (timestamp for surfacing "ran out X days ago" UI).
--   - pg_cron job auto-relist-unsold runs every 10 minutes:
--     1. find each unsold lot at an operator with auto_relist_enabled and
--        relist_count < max_attempts
--     2. resolve the next eligible auction at the same warehouse
--     3. mint a new lot via relist_lot_into_auction() helper
--     4. mark source lot as 'relisted', increment counters
--   - Lots that exhaust max_attempts stay 'unsold' and surface in the
--     "needs manual review" queue on /lotting/inventory.
--
-- Also exposes relist_lot_into_auction(lot_id, auction_id) as an RPC for
-- manual relist by operator-web + field-mobile.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Operator-level config
-- ---------------------------------------------------------------------------

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS auto_relist_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS auto_relist_max_attempts INTEGER NOT NULL DEFAULT 2;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operators_auto_relist_attempts_bounds'
  ) THEN
    ALTER TABLE operators
      ADD CONSTRAINT operators_auto_relist_attempts_bounds
      CHECK (auto_relist_max_attempts >= 0 AND auto_relist_max_attempts <= 10);
  END IF;
END $$;

COMMENT ON COLUMN operators.auto_relist_enabled IS
  'When true, the auto-relist cron job moves the operator''s unsold lots '
  'into the next eligible auction at the same warehouse, up to '
  'auto_relist_max_attempts times.';

COMMENT ON COLUMN operators.auto_relist_max_attempts IS
  'Maximum number of automatic relistings per lot. Default 2 means the '
  'lot gets 2 additional auctions after the original before staff has '
  'to decide what to do with it. 0 disables auto-relist for this operator.';

-- ---------------------------------------------------------------------------
-- 2. Lot-level lineage + counter
-- ---------------------------------------------------------------------------

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS relist_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS relisted_from_lot_id UUID REFERENCES lots(id) ON DELETE SET NULL;

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS last_relisted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS lots_unsold_for_relist_idx
  ON lots(operator_id, status, relist_count)
  WHERE status = 'unsold' AND deleted_at IS NULL;

COMMENT ON COLUMN lots.relisted_from_lot_id IS
  'When this lot was created via auto-relist (or manual relistLot), points '
  'at the previous lot in the chain. Lets us trace lineage for the unsold '
  'lot that originally entered inventory N auctions ago.';

COMMENT ON COLUMN lots.relist_count IS
  'How many times the SOURCE lot (originally minted at intake) has been '
  'relisted. Inherited and incremented through the relist chain. Compared '
  'against operators.auto_relist_max_attempts to decide eligibility.';

-- ---------------------------------------------------------------------------
-- 3. relist_lot_into_auction(lot_id, auction_id) — shared helper
-- ---------------------------------------------------------------------------
-- Single canonical relist implementation. Used by:
--   - operator-web manual relist server action
--   - field-mobile manual relist action
--   - auto-relist pg_cron job (via relist_one_unsold_lot below)
--
-- Guarantees:
--   - source lot is in a relistable state (unsold, in_inventory, relisted)
--   - target auction belongs to same operator, same warehouse, draft/sched
--   - mints a new lot_code via next_lot_code()
--   - copies metadata + photos
--   - sets relisted_from_lot_id + relist_count = source.relist_count + 1
--   - flips source lot to 'relisted'
--
-- Returns the new lot id on success or NULL on a recoverable skip
-- (constraint violations bubble up as PG exceptions).

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
  -- Resolve the source lot under FOR UPDATE so concurrent relist
  -- attempts (manual + auto) on the same source serialize.
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

  -- Mint a fresh lot_code so the new lot is scannable + labelable.
  SELECT next_lot_code(v_op_id) INTO v_new_code;
  IF v_new_code IS NULL THEN
    RAISE EXCEPTION 'relist_lot_code_mint_failed' USING ERRCODE = 'P0001';
  END IF;

  -- Next lot_number in the target auction.
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
    -- The relisted lot starts back "in inventory" — it lives at the same
    -- physical bin as its source, so we copy the bin reference forward.
    -- The bidder pickup map will show the right bin without staff having
    -- to re-scan it. (If the source had no bin somehow, this stays NULL.)
    v_src.intake_at, v_src.intake_bin_id
  )
  RETURNING id INTO v_new_lot_id;

  -- Mark the source as relisted. The relisted_from_lot_id on the new row
  -- preserves the audit chain. Source's relist_count stays whatever it
  -- was — the counter "rolls forward" onto the new row.
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

-- ---------------------------------------------------------------------------
-- 4. auto_relist_unsold_lots() — pg_cron entry point
-- ---------------------------------------------------------------------------
-- Runs every 10 minutes. For each operator with auto_relist_enabled:
--   - finds unsold lots whose relist_count < max_attempts
--   - resolves the next eligible auction at the same warehouse:
--     status='draft' or 'scheduled', ends_at in the future
--   - calls relist_lot_into_auction()
--
-- Idempotency: relist_lot_into_auction flips the source to 'relisted', so
-- the WHERE clause naturally excludes already-processed lots on the next
-- tick. Advisory lock prevents overlapping ticks from double-processing
-- the same lot.

CREATE OR REPLACE FUNCTION auto_relist_unsold_lots()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op           RECORD;
  v_lot          RECORD;
  v_auction_id   UUID;
  v_relisted     INT := 0;
  v_failed       INT := 0;
  v_skipped      INT := 0;
  v_err_msg      TEXT;
BEGIN
  -- Advisory lock so overlapping cron ticks don't double-process.
  IF NOT pg_try_advisory_xact_lock(7423940124) THEN
    RETURN jsonb_build_object('skipped', 'lock_held');
  END IF;

  FOR v_op IN
    SELECT id AS operator_id, auto_relist_max_attempts
    FROM operators
    WHERE auto_relist_enabled = TRUE
      AND auto_relist_max_attempts > 0
  LOOP
    FOR v_lot IN
      SELECT id, warehouse_id, relist_count
      FROM lots
      WHERE operator_id = v_op.operator_id
        AND status = 'unsold'
        AND COALESCE(relist_count, 0) < v_op.auto_relist_max_attempts
        AND deleted_at IS NULL
      ORDER BY closed_at ASC NULLS LAST
      LIMIT 500
    LOOP
      -- Find the next eligible auction: same warehouse, draft/scheduled,
      -- ends in the future, soonest first. Prefer scheduled (live soon)
      -- over draft (still being assembled) so the lot has a fresh shot
      -- sooner.
      SELECT id INTO v_auction_id
      FROM auctions
      WHERE operator_id = v_op.operator_id
        AND warehouse_id = v_lot.warehouse_id
        AND status IN ('draft', 'scheduled')
        AND ends_at > now()
      ORDER BY
        CASE WHEN status = 'scheduled' THEN 0 ELSE 1 END,
        ends_at ASC
      LIMIT 1;

      IF v_auction_id IS NULL THEN
        -- No eligible target right now — leave the lot in unsold for
        -- the operator to handle manually. Next tick will retry.
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      BEGIN
        IF relist_lot_into_auction(v_lot.id, v_auction_id) IS NOT NULL THEN
          v_relisted := v_relisted + 1;
        ELSE
          v_failed := v_failed + 1;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_err_msg := SQLERRM;
        v_failed := v_failed + 1;
        -- Don't bail the whole loop on one bad lot; surface in logs.
        RAISE WARNING 'auto_relist failed for lot %: %', v_lot.id, v_err_msg;
      END;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'relisted', v_relisted,
    'failed', v_failed,
    'skipped', v_skipped,
    'at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION auto_relist_unsold_lots() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 5. Schedule the auto-relist job on pg_cron
-- ---------------------------------------------------------------------------
-- Every 10 minutes. The job is cheap (filtered scan per operator) and the
-- 10-min cadence means a lot that closed unsold at 2:00pm gets relisted
-- by 2:10pm — fast enough that the operator sees it in the right state
-- when they refresh, slow enough not to thrash if a flurry of auctions
-- close together.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'auto-relist-unsold'
  ) THEN
    PERFORM cron.unschedule('auto-relist-unsold');
  END IF;
  PERFORM cron.schedule(
    'auto-relist-unsold',
    '*/10 * * * *',  -- every 10 minutes
    $cron$SELECT public.auto_relist_unsold_lots()$cron$
  );
END $$;

COMMIT;
