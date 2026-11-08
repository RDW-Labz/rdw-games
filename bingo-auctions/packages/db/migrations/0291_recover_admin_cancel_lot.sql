-- ============================================================================
-- Migration 0291 — re-commit `admin_cancel_lot` (originally 0274)
--
-- WHY THIS EXISTS -----------------------------------------------------------
--
-- `_schema_migrations` on prod records four migrations that were applied but
-- never committed to this repo (same class of drift 0285 fixed for 0275):
--
--   0273_putaway_location_regardless_of_status.sql   applied 2026-07-16 19:32
--   0274_admin_cancel_lot.sql                        applied 2026-07-16 21:33
--   0275_relist_dedup_guards.sql                     applied 2026-07-16 23:51  → recovered as 0285
--   0276_relist_dedup_repair_and_index.sql           applied 2026-07-17 00:00  → superseded by 0290
--
-- A rebuild from this repo would silently LOSE whatever those added. This file
-- closes 0274 by re-committing the currently-deployed body verbatim, read via
-- `pg_get_functiondef` on prod 2026-07-27. It is CREATE OR REPLACE and
-- byte-identical to what prod already runs, so re-applying is a safe no-op.
--
-- STATUS OF THE OTHER TWO -------------------------------------------------
--
--   0276 — created the unique index `lots_one_active_relist_child` plus a
--          one-off data repair. Migration 0290 DROPs and recreates that index
--          (re-keyed onto status; see 0290's header for why the canceled_at
--          version was wrong in both directions), so 0276's durable effect is
--          now owned by 0290 and no recovery file is needed. The data repair
--          was a one-off and is already reflected in the rows.
--
--   0273 — modified three bin/intake RPCs so a lot's putaway location is
--          recorded regardless of its status. The deployed bodies of
--          `intake_lot_to_bin`, `batch_intake_lot_to_bin` and
--          `confirm_move_lot_to_bin` all still carry their `0273` comment
--          markers on prod, so they are recoverable the same way this file
--          recovers 0274 — but they are long and unchanged since, so they are
--          left for a follow-up rather than transcribed here. Tracked in the
--          PR description. Prod is correct today either way; the exposure is
--          only "a from-scratch rebuild loses the 0273 behaviour."
--
-- WHAT admin_cancel_lot DOES ----------------------------------------------
--
-- Admin-only single-lot cancel. Refuses a `won` lot (needs the refund/void
-- flow), requires `p_force` for a lot with bids, is idempotent when already
-- canceled/deleted, and detaches the lot from its auction so it stops being a
-- visible listing. Note it sets `status='canceled'` in the SAME update as
-- `canceled_at` — which is why 0290's activate-clears-stamp trigger cannot
-- undo a real admin cancel.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_cancel_lot(
  p_lot_id UUID,
  p_reason TEXT DEFAULT NULL::text,
  p_force BOOLEAN DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user  uuid := auth.uid();
  v_op_id uuid;
  v_role  operator_user_role;
  v_lot   lots%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT ou.operator_id, ou.role INTO v_op_id, v_role
  FROM operator_users ou WHERE ou.user_id = v_user LIMIT 1;

  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_operator_staff');
  END IF;
  -- ADMIN-ONLY, by owner request.
  IF v_role <> 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'admin_only', 'role', v_role);
  END IF;

  -- Lock the lot so concurrent cancels serialize.
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL OR v_lot.operator_id <> v_op_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lot_not_found');
  END IF;

  -- Idempotent no-op when already gone.
  IF v_lot.status = 'canceled' OR v_lot.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id,
                              'lot_code', v_lot.lot_code, 'already_canceled', true);
  END IF;

  -- A won lot has a buyer + invoice; canceling it needs the refund/void flow.
  IF v_lot.status = 'won' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lot_won_needs_refund_flow',
                              'lot_code', v_lot.lot_code);
  END IF;

  -- Bidded lots require an explicit force (pre-close: voids open bids, no charge).
  IF v_lot.bid_count > 0 AND NOT p_force THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lot_has_bids',
                              'lot_code', v_lot.lot_code, 'bid_count', v_lot.bid_count);
  END IF;

  UPDATE lots
     SET status      = 'canceled',
         auction_id  = NULL,
         lot_number  = NULL,
         close_at    = NULL,
         canceled_at = now(),
         canceled_by = v_user,
         updated_at  = now()
   WHERE id = p_lot_id;

  -- Reason is operator courtesy; the durable audit is canceled_at/by. (Mirrors
  -- cancel_auction, which also PERFORMs the reason pending a status_history table.)
  PERFORM p_reason;

  RETURN jsonb_build_object(
    'ok', true,
    'lot_id', p_lot_id,
    'lot_code', v_lot.lot_code,
    'was_status', v_lot.status,
    'had_bids', (v_lot.bid_count > 0),
    'from_auction_id', v_lot.auction_id,
    'canceled_by', v_user,
    'canceled_at', now()
  );
END;
$function$;

COMMIT;
