-- ROLLBACK for 0471 (withdraw a lot; undo withdraw; undo Dispose / Business use).
--
-- Refuses while a withdrawal can still be undone (open, close time in the
-- future): after rollback nobody could put that lot back in its auction.
-- Undo those (or wait for their close time) first.
--
-- Restores keep_lot_for_business (0381) and lots_removal_is_terminal (0319)
-- exactly as they are on master (bodies copied from a master replay), drops
-- the new functions and the two tables (their history goes with them; the
-- operator_audit_log rows stay). Withdrawn lots stay 'canceled'; undone
-- removals stay restored. The two notification_kind values cannot be dropped
-- from an enum; nothing enqueues them after rollback.

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF to_regclass('public.lot_withdrawals') IS NOT NULL THEN
    LOCK TABLE public.lot_withdrawals IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public.lot_withdrawals WHERE undone_at IS NULL AND close_at > now()) THEN
      RAISE EXCEPTION '0471 rollback refused: a withdrawn lot can still be put back in its auction';
    END IF;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.withdraw_lot_from_auction(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.undo_lot_withdrawal(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.undo_lot_removal(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.dispose_lot_attributed(UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.keep_lot_for_business_attributed(UUID, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.lot_staff_action_check(UUID, TEXT, TEXT, TEXT[]);

-- master (0381) keep_lot_for_business, verbatim:
CREATE OR REPLACE FUNCTION public.keep_lot_for_business(p_lot_id uuid, p_price_cents integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller  UUID := auth.uid();
  v_op_id   UUID;
  v_role    operator_user_role;
  v_lot     lots%ROWTYPE;
  v_reason  TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_bids    INT;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  IF p_price_cents IS NULL OR p_price_cents < 0 OR p_price_cents > 100000000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_price');
  END IF;
  IF v_reason IS NULL OR length(v_reason) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required');
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

  IF v_lot.removal_kind IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM lot_internal_keeps k WHERE k.lot_id = p_lot_id) THEN
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'lot_id', p_lot_id);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_removed_as_' || v_lot.removal_kind);
  END IF;

  IF v_lot.status = 'canceled' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_canceled');
  END IF;
  IF v_lot.status = 'disposed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_disposed');
  END IF;
  IF v_lot.status = 'won' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_on_invoice');
  END IF;

  IF v_lot.status IN ('scheduled', 'live') THEN
    SELECT count(*)::INT INTO v_bids FROM bids WHERE lot_id = p_lot_id;
    IF v_bids > 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'lot_live_with_bids', 'bids', v_bids);
    END IF;
  END IF;

  -- Any invoice line that still stands (not refunded, invoice not canceled or
  -- fully refunded) means someone bought this lot: Phase 2, not this.
  IF EXISTS (
    SELECT 1 FROM invoice_lots il JOIN invoices i ON i.id = il.invoice_id
    WHERE il.lot_id = p_lot_id
      AND il.refunded_at IS NULL
      AND i.status NOT IN ('canceled', 'refunded')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_on_invoice');
  END IF;

  INSERT INTO lot_internal_keeps (
    lot_id, operator_id, kept_price_cents, reason, kept_by,
    prior_status, prior_auction_id, lot_code, title)
  VALUES (
    p_lot_id, v_op_id, p_price_cents, v_reason, v_caller,
    v_lot.status, v_lot.auction_id, v_lot.lot_code, v_lot.title);

  UPDATE lots
     SET status               = 'disposed',
         removal_kind         = 'other',
         removed_at           = now(),
         removed_by           = v_caller,
         removal_note         = left('kept for business: ' || v_reason, 1000),
         flagged_for_disposal = TRUE,
         flagged_at           = COALESCE(flagged_at, now()),
         flagged_reason       = COALESCE(flagged_reason, 'kept for business'),
         updated_at           = now()
   WHERE id = p_lot_id;

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES (
    v_op_id, v_caller, 'lot.kept_for_business', p_lot_id,
    jsonb_build_object('status', v_lot.status, 'auction_id', v_lot.auction_id),
    jsonb_build_object('status', 'disposed', 'removal_kind', 'other', 'kept_price_cents', p_price_cents),
    v_reason);

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id, 'kept_price_cents', p_price_cents);
END;
$function$;

-- master (0319) lots_removal_is_terminal, verbatim (not SECURITY DEFINER):
CREATE OR REPLACE FUNCTION public.lots_removal_is_terminal()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.removal_kind IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.removal_kind IS DISTINCT FROM OLD.removal_kind THEN
    RAISE EXCEPTION
      'lot_removal_is_permanent: lot % was recorded as % and cannot be re-classified',
      OLD.id, OLD.removal_kind
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status <> 'disposed' THEN
    RAISE EXCEPTION
      'lot_removal_is_permanent: lot % was removed from inventory (%) and cannot return to status %',
      OLD.id, OLD.removal_kind, NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.keep_lot_for_business(UUID, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.keep_lot_for_business(UUID, INTEGER, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.keep_lot_for_business(UUID, INTEGER, TEXT) TO authenticated, service_role;

DROP TABLE IF EXISTS public.lot_removal_undos;
DROP TABLE IF EXISTS public.lot_withdrawals;

COMMIT;
