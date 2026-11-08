-- migration 0146 — lots disposal flag + auto-flag in cron + mark_lot_disposed (W5-DB)
--
-- Per docs/state/PLAN-field-mobile-restructure-2026-05-25.md W5:
--   Worklist tab needs a "Flagged for disposal" section. The column
--   doesn''t exist yet. Add it, extend the auto_relist_unsold_lots cron
--   to set flagged_for_disposal=true when relist_count >=
--   operators.auto_flag_disposal_at_strikes (mig 0144 W8), and add a
--   staff/manager-callable RPC mark_lot_disposed(lot_id, reason).
--
-- ── Why ───────────────────────────────────────────────────────────────────
-- An item that has been listed in 5+ auctions without selling is unlikely
-- to ever sell at the operator''s current price/condition. Pre-W5 these
-- lots stayed in `status=unsold` indefinitely with no UI affordance for
-- staff to triage them. Worklist UI (W5-UI, Phase C) will surface them
-- so staff can either:
--   - dispose (call mark_lot_disposed → status=''disposed'')
--   - re-photo / re-price and manually relist
--   - donate / discard
--
-- The threshold is operator-configurable via operators.auto_flag_disposal_at_strikes
-- (W8, mig 0144, default 5). The W5-DB cron extension reads this column.
--
-- ── Schema additions ─────────────────────────────────────────────────────
--   lots.flagged_for_disposal BOOLEAN NOT NULL DEFAULT FALSE
--   lots.flagged_at           TIMESTAMPTZ
--   lots.flagged_reason       TEXT
--
-- Partial index on flagged_for_disposal=TRUE so the Worklist query can
-- find them efficiently regardless of operator size.
--
-- ── Cron extension ───────────────────────────────────────────────────────
-- auto_relist_unsold_lots() is REPLACEd with:
--   - existing relist behavior (unchanged)
--   - PLUS: for each operator, after the relist loop, find lots that
--     hit relist_count >= auto_flag_disposal_at_strikes AND are NOT
--     yet flagged_for_disposal, and flag them.
--
-- The flag is independent of the relist outcome — a lot might be
-- relisted into another auction AND simultaneously hit the strike
-- threshold. Both happen in the same tick.
--
-- ── mark_lot_disposed RPC ────────────────────────────────────────────────
-- Staff/manager action. Sets status=''disposed'', stamps flagged_*. The
-- lot is removed from any active auction (FK cascade) — auctions code
-- already handles this elsewhere.
--
-- ── Idempotency ───────────────────────────────────────────────────────────
-- All ADD COLUMN IF NOT EXISTS. CREATE OR REPLACE for the cron function.
-- Cron job re-schedule is guarded by the existing DO-block in 0097.

-- ---------------------------------------------------------------------------
-- 0. Ensure ''disposed'' is in the lot_status enum BEFORE any function that
--    references it as a string literal is parsed/created. Per migration
--    0104''s header, Postgres allows ALTER TYPE ADD VALUE inside a txn,
--    but to match the conservative pattern we run it at the top before
--    BEGIN. ADD VALUE IF NOT EXISTS is a no-op if the value already exists.
-- ---------------------------------------------------------------------------

ALTER TYPE lot_status ADD VALUE IF NOT EXISTS 'disposed';

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. lots disposal columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS flagged_for_disposal BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ;

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS flagged_reason TEXT;

CREATE INDEX IF NOT EXISTS lots_flagged_for_disposal_idx
  ON public.lots(operator_id, flagged_at DESC)
  WHERE flagged_for_disposal = TRUE;

COMMENT ON COLUMN public.lots.flagged_for_disposal IS
  'TRUE means the lot has exhausted auto-relist attempts (>= '
  'operators.auto_flag_disposal_at_strikes) and is awaiting staff '
  'disposition. Set by the auto_relist_unsold_lots cron OR by manual '
  'staff action via mark_lot_disposed (which sets status=disposed too). '
  'See migration 0146 (W5-DB) and plan W5-UI for the Worklist section '
  'that surfaces these.';

COMMENT ON COLUMN public.lots.flagged_at IS
  'When the flag was set. NULL if flagged_for_disposal=FALSE.';

COMMENT ON COLUMN public.lots.flagged_reason IS
  'Optional staff-provided reason when manually flagging via '
  'mark_lot_disposed. Auto-flagging by cron sets this to '
  '"auto: exceeded auto_flag_disposal_at_strikes".';

-- ---------------------------------------------------------------------------
-- 2. auto_relist_unsold_lots — extended to also flag-for-disposal
-- ---------------------------------------------------------------------------
-- Same body as 0097 + the disposal-flag pass at the end of each operator
-- iteration. Lots that have hit the operator''s strike threshold get
-- flagged_for_disposal=TRUE and a reason stamp. The relist loop runs
-- first so a lot that gets one last relist before hitting the threshold
-- has that final shot before being flagged.

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
  'W5-DB extension (mig 0146): in addition to the 0097 relist behavior, '
  'flips flagged_for_disposal=TRUE on lots whose relist_count has hit '
  'the operator''s auto_flag_disposal_at_strikes threshold (W8 mig 0144). '
  'Returns counts of relisted / failed / skipped / flagged_for_disposal.';

-- ---------------------------------------------------------------------------
-- 3. mark_lot_disposed RPC — staff/manager action
-- ---------------------------------------------------------------------------
-- Sets status=''disposed'', stamps the disposal flag with the operator-
-- supplied reason. Returns jsonb.
--
-- Auth: caller must be staff of the operator that owns the lot. We
-- restrict to admin/manager since disposing is a destructive (status-
-- terminal) action — picker/checkout staff don''t get this RPC.

CREATE OR REPLACE FUNCTION mark_lot_disposed(
  p_lot_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller    UUID := auth.uid();
  v_op_id     UUID;
  v_role      operator_user_role;
  v_lot       lots%ROWTYPE;
  v_clean_rsn TEXT := NULLIF(TRIM(COALESCE(p_reason, '')), '');
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT operator_id, role INTO v_op_id, v_role
    FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;
  IF v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'admin_or_manager_required');
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_other_operator');
  END IF;
  IF v_lot.status = 'disposed' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'lot_id', p_lot_id);
  END IF;

  UPDATE lots
     SET status = 'disposed',
         flagged_for_disposal = TRUE,
         flagged_at = COALESCE(flagged_at, now()),
         flagged_reason = COALESCE(v_clean_rsn, 'manual disposal'),
         updated_at = now()
   WHERE id = p_lot_id;

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id);
END;
$$;

REVOKE ALL ON FUNCTION mark_lot_disposed(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_lot_disposed(UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION mark_lot_disposed(UUID, TEXT) IS
  'W5-DB (mig 0146): admin/manager-only RPC that flips a lot to '
  'status=disposed and stamps the disposal flag. Idempotent on '
  'already-disposed lots. Picker/checkout staff cannot call this.';

COMMIT;
