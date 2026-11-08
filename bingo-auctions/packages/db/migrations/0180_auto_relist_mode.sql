-- migration 0180 — auto-relist review gate (operators.auto_relist_mode)
--
-- Live-test feedback 2026-06-03 (operator's #1 ask): "I want a chance to
-- review unsold lots before they auto-relist into the next auction." Today
-- auto_relist_unsold_lots() mints relisted lots unconditionally for every
-- operator with auto_relist_enabled — the operator gets no say per-lot.
--
-- ── The model ──────────────────────────────────────────────────────────────
-- New operator column auto_relist_mode TEXT with three values:
--   'auto'   → existing behavior: the cron mints relisted lots into the next
--              eligible auction automatically (current production behavior).
--   'review' → the cron does NOT mint. Unsold lots stay status='unsold' and
--              surface on /worklist (Needs re-lot) where staff relist / pull /
--              dispose them by hand. This is the new default for NEW operators.
--   'off'    → same as review for the minting decision (cron does not mint);
--              the operator has opted out of auto-relist entirely. (off vs
--              review differ only in UI intent + the existing
--              auto_relist_enabled toggle; both leave the lot in 'unsold'.)
--
-- ── No silent behavior change on deploy ─────────────────────────────────────
-- The column DEFAULT is 'review' (safe for new operators), but we BACKFILL
-- every EXISTING operator to 'auto' so no live operator's behavior changes
-- the moment this ships. They keep auto-relisting exactly as before until an
-- admin opts into review via Settings → Auto-relist. No specific operator
-- UUID is hardcoded — the backfill is a blanket UPDATE.
--
-- ── What this migration gates (and what it deliberately does NOT) ───────────
-- ONLY the CONSUMER auto_relist_unsold_lots() is gated. The relist loop now
-- runs only for operators whose auto_relist_mode = 'auto', alongside the
-- existing auto_relist_enabled / auto_relist_max_attempts gates.
--
-- The PRODUCERS that land lots in 'unsold' are intentionally untouched —
-- they are correct regardless of relist mode:
--   • finalize_scheduled_no_bid_lots()  (a no-bid lot closes → unsold)
--   • the no-show / forfeiture cron      (a no-show pickup → unsold)
--   • grace-expiry                       (grace lapses → unsold)
-- A 'review'/'off' operator's lots still correctly become 'unsold'; they
-- simply wait on /worklist for a human instead of being re-minted.
--
-- ── Verbatim preservation ──────────────────────────────────────────────────
-- The auto_relist_unsold_lots() body below is the EXACT live definition from
-- migration 0146 (W5-DB: relist loop + disposal-flag pass). Every line is
-- reproduced unchanged EXCEPT:
--   (1) the operator-selection FOR loop also selects auto_relist_mode and adds
--       `AND auto_relist_mode = 'auto'` to its WHERE, so the relist + flag
--       passes only execute for 'auto' operators.
-- Nothing else changes. CREATE OR REPLACE preserves the existing ACL.
--
-- ── Idempotency / risk: low ────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS + idempotent CHECK constraint guard. The backfill
-- is a blanket UPDATE (safe to re-run). CREATE OR REPLACE on the function with
-- identical signature auto_relist_unsold_lots() RETURNS jsonb. No schema
-- change to lots. The new gate fails CLOSED (skips minting) only for
-- operators who are not in 'auto' mode.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. operators.auto_relist_mode column + CHECK + backfill
-- ---------------------------------------------------------------------------

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS auto_relist_mode TEXT NOT NULL DEFAULT 'review'
    CHECK (auto_relist_mode IN ('auto', 'review', 'off'));

-- Backfill EVERY existing operator to 'auto' so no live operator's behavior
-- silently changes on deploy. New operators inherit the 'review' default.
UPDATE operators SET auto_relist_mode = 'auto';

COMMENT ON COLUMN operators.auto_relist_mode IS
  'Auto-relist review gate (mig 0180). '
  '''auto'' = auto_relist_unsold_lots() mints relisted lots automatically '
  '(legacy behavior; backfilled onto all pre-0180 operators). '
  '''review'' = cron does NOT mint; unsold lots wait on /worklist for staff '
  'to relist / pull / dispose by hand (default for new operators). '
  '''off'' = operator opted out of auto-relist; cron does not mint. '
  'Only the consumer cron reads this — producers still land lots in unsold.';

-- ---------------------------------------------------------------------------
-- 2. auto_relist_unsold_lots() — gate the relist + flag passes on
--    auto_relist_mode = 'auto'
-- ---------------------------------------------------------------------------
-- Verbatim copy of the mig-0146 definition. ONLY change: the operator
-- selection loop adds auto_relist_mode to its SELECT and
-- `AND auto_relist_mode = 'auto'` to its WHERE. For 'review'/'off' operators
-- the loop body never runs, so their unsold lots are neither minted into an
-- auction nor disposal-flagged by the cron — they stay status='unsold' for
-- manual handling on /worklist.

CREATE OR REPLACE FUNCTION auto_relist_unsold_lots()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op             RECORD;
  v_lot            RECORD;
  v_auction_id     UUID;
  v_relisted       INT := 0;
  v_failed         INT := 0;
  v_skipped        INT := 0;
  v_flagged        INT := 0;
  v_err_msg        TEXT;
BEGIN
  IF NOT pg_try_advisory_xact_lock(7423940124) THEN
    RETURN jsonb_build_object('skipped', 'lock_held');
  END IF;

  FOR v_op IN
    SELECT id AS operator_id,
           auto_relist_max_attempts,
           auto_flag_disposal_at_strikes
    FROM operators
    WHERE auto_relist_enabled = TRUE
      AND auto_relist_max_attempts > 0
      -- mig 0180: review gate. Only 'auto' operators get automatic minting.
      -- 'review'/'off' operators leave their unsold lots for /worklist.
      AND auto_relist_mode = 'auto'
  LOOP
    -- ── 1) Relist eligible unsold lots ─────────────────────────────────
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
        RAISE WARNING 'auto_relist failed for lot %: %', v_lot.id, v_err_msg;
      END;
    END LOOP;

    -- ── 2) Flag-for-disposal pass (W5-DB) ──────────────────────────────
    -- Lots that have exhausted strikes and aren''t already flagged.
    -- We don''t change `status` here — the disposal-flag is orthogonal to
    -- status. A lot at the strike threshold may be in `unsold`,
    -- `in_inventory` (auto-relist re-binned it), or `relisted` (chain
    -- continuation) — Worklist UI shows all three under "Flagged".
    UPDATE lots
       SET flagged_for_disposal = TRUE,
           flagged_at = now(),
           flagged_reason = 'auto: exceeded auto_flag_disposal_at_strikes ('
                            || v_op.auto_flag_disposal_at_strikes || ')',
           updated_at = now()
     WHERE operator_id = v_op.operator_id
       AND COALESCE(relist_count, 0) >= v_op.auto_flag_disposal_at_strikes
       AND flagged_for_disposal = FALSE
       AND deleted_at IS NULL
       AND status <> 'disposed';
    GET DIAGNOSTICS v_flagged = ROW_COUNT;
  END LOOP;

  RETURN jsonb_build_object(
    'relisted', v_relisted,
    'failed', v_failed,
    'skipped', v_skipped,
    'flagged_for_disposal', v_flagged,
    'at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION auto_relist_unsold_lots() FROM PUBLIC;

COMMENT ON FUNCTION auto_relist_unsold_lots() IS
  'W5-DB extension (mig 0146) + review gate (mig 0180): mints relisted lots '
  'and flags-for-disposal ONLY for operators with auto_relist_mode = ''auto'' '
  '(alongside the auto_relist_enabled / auto_relist_max_attempts gates). '
  '''review''/''off'' operators leave their unsold lots for manual handling on '
  '/worklist. Returns counts of relisted / failed / skipped / '
  'flagged_for_disposal.';

COMMIT;
