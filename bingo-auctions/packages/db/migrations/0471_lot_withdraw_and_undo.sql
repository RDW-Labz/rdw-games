-- ============================================================================
-- Migration 0471 — withdraw a lot from its auction; undo it; undo Dispose and
-- Business use within 24 hours. Every action needs a typed staff name and a
-- reason, and is audited.
--
-- Owner decisions, 2026-10-27 (lot #80 BRN4371497 could not be disposed while
-- live with a $1 preview bid):
--   (a) Withdraw a live/scheduled lot, even with bids: admin or manager,
--       typed name + required reason. Bidders are told by push / in-app only
--       (new notification kind lot_withdrawn: the email drain has no template
--       for it and the SMS drain allow-list does not include it). Refused if
--       the lot is won, sold or on an invoice. Bid history is kept. Undo until
--       the auction closes.
--   (b) Dispose (remove_lot_from_inventory) and Business use
--       (keep_lot_for_business): admin-only undo within 24 hours, typed name
--       + reason, audited. The console versions of both now need a typed name
--       and a reason too.
--
-- The seller policy (0379) already says: "BinGo may withdraw a lot before it
-- closes. Bids on a withdrawn lot are void and no one is charged."
--
-- What changes:
--   (1) notification_kind gains 'lot_withdrawn' and 'lot_reinstated'.
--   (2) lot_withdrawals: one row per withdrawal, with everything undo needs
--       (auction, lot number, close time, price, leader). Server only.
--   (3) withdraw_lot_from_auction(lot, staff_name, reason): the lot becomes
--       'canceled' and leaves the auction exactly like admin_cancel_lot
--       (auction_id / lot_number / close_at cleared), so the close never
--       finalizes it (finalize_lot / finalize_due_lots act on 'live' only),
--       no invoice can include it (build_invoices_for_auction takes 'won'
--       only) and place_bid refuses it (scheduled/live only). The bids rows
--       stay. Each distinct bidder gets one lot_withdrawn notification.
--   (4) undo_lot_withdrawal(lot, staff_name, reason): puts the lot back in
--       the same auction, number, close time, price and leader -- only while
--       that auction is still open and the lot's close time is in the future,
--       and only if it was not disposed / kept since. Bidders are told.
--   (5) keep_lot_for_business: a CANCELED lot (withdrawn, admin_cancel_lot,
--       or canceled before it opened; not hard-deleted) can now be kept, and
--       so can a WON lot whose sale is undone (it has invoice lines and every
--       one is refunded or on a canceled / refunded invoice). The existing
--       live-invoice check still refuses anything sold. Body otherwise
--       identical to 0381. (remove_lot_from_inventory already accepts
--       canceled and won lots; unchanged.)
--   (6) dispose_lot_attributed / keep_lot_for_business_attributed: the
--       console's Dispose and Business use, with typed name + reason, audited.
--       The old 3-argument RPCs stay as they are for the staff app (mark
--       missing, worklist), which has no name field yet.
--   (7) undo_lot_removal(lot, staff_name, reason): admin only, within 24 h of
--       the removal. The lot returns to the status it had before (from
--       lot_status_history); a lot that was scheduled/live/draft returns to
--       'in_inventory' outside any auction. A kept lot's keep row is deleted
--       (copied into the audit row first).
--   (8) lots_removal_is_terminal: unchanged EXCEPT it lets exactly one
--       transaction through -- the one undo_lot_removal is running, proven by
--       a lot_removal_undos row written in the same transaction (txid). No
--       client can write that table. It becomes SECURITY DEFINER to read it.
--
-- LOCKS / WINDOW
--   ALTER TYPE notification_kind ADD VALUE (type lock, ms). CREATE TABLE x2.
--   CREATE OR REPLACE FUNCTION of the lots trigger FUNCTION only -- no ALTER
--   / CREATE TRIGGER on lots, so no lock on lots, bids or invoices.
--   lock_timeout 3s. Behaviour reaches staff (console lot page) and bidders
--   (notifications): console deploy 09:00-16:00 CT right after this applies.
--   Applying it alone changes nothing anyone sees (new functions nobody calls
--   until the console deploys).
--
-- Idempotent: ADD VALUE IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, CREATE OR
-- REPLACE, DROP ... IF EXISTS before CREATE.
-- Rollback: scripts/prod-rig/0471_ROLLBACK_lot_withdraw_and_undo.sql
-- ============================================================================

-- ADD VALUE cannot share a transaction with a use of the new value; nothing
-- below USES it at create time (plpgsql bodies resolve it at call time).
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'lot_withdrawn';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'lot_reinstated';

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ----------------------------------------------------------------------------
-- (2) lot_withdrawals
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lot_withdrawals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id             UUID NOT NULL REFERENCES public.lots(id) ON DELETE CASCADE,
  operator_id        UUID NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  auction_id         UUID REFERENCES public.auctions(id) ON DELETE SET NULL,
  lot_number         INTEGER,
  close_at           TIMESTAMPTZ,
  prior_status       TEXT NOT NULL,
  current_bid_cents  BIGINT,
  current_bid_id     UUID,
  winner_bidder_id   UUID,
  bid_count          INTEGER NOT NULL DEFAULT 0,
  bidders_notified   INTEGER NOT NULL DEFAULT 0,
  staff_name         TEXT NOT NULL,
  reason             TEXT NOT NULL,
  withdrawn_by       UUID,
  withdrawn_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at          TIMESTAMPTZ,
  undone_by          UUID,
  undo_staff_name    TEXT,
  undo_reason        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS lot_withdrawals_one_open_per_lot
  ON public.lot_withdrawals (lot_id) WHERE undone_at IS NULL;

COMMENT ON TABLE public.lot_withdrawals IS
  'mig 0471: a lot pulled from its auction by staff (typed name + reason). '
  'Holds the auction, number, close time, price and leader so undo can put it '
  'back. undone_at set = reinstated. Staff of the operator read; no client writes.';

ALTER TABLE public.lot_withdrawals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lot_withdrawals FROM PUBLIC;
REVOKE ALL ON public.lot_withdrawals FROM anon, authenticated;
GRANT SELECT ON public.lot_withdrawals TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.lot_withdrawals TO service_role;

DROP POLICY IF EXISTS lot_withdrawals_staff_read ON public.lot_withdrawals;
CREATE POLICY lot_withdrawals_staff_read ON public.lot_withdrawals
  FOR SELECT USING (operator_id = (SELECT current_operator_id()));

-- ----------------------------------------------------------------------------
-- lot_removal_undos: one row per undone Dispose / Business use. txid ties the
-- row to the transaction the terminal trigger lets through.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lot_removal_undos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id          UUID NOT NULL REFERENCES public.lots(id) ON DELETE CASCADE,
  operator_id     UUID NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  removal_kind    TEXT NOT NULL,
  removal_note    TEXT,
  removed_at      TIMESTAMPTZ,
  removed_by      UUID,
  kept_row        JSONB,
  restored_status TEXT NOT NULL,
  staff_name      TEXT NOT NULL,
  reason          TEXT NOT NULL,
  undone_by       UUID NOT NULL,
  undone_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  txid            BIGINT NOT NULL DEFAULT txid_current()
);

CREATE INDEX IF NOT EXISTS lot_removal_undos_lot_idx ON public.lot_removal_undos (lot_id, txid);

COMMENT ON TABLE public.lot_removal_undos IS
  'mig 0471: Dispose / Business use undone by an admin within 24 h (typed '
  'name + reason). The only way past lots_removal_is_terminal. No client writes.';

ALTER TABLE public.lot_removal_undos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lot_removal_undos FROM PUBLIC;
REVOKE ALL ON public.lot_removal_undos FROM anon, authenticated;
GRANT SELECT ON public.lot_removal_undos TO authenticated;
GRANT SELECT ON public.lot_removal_undos TO service_role;

DROP POLICY IF EXISTS lot_removal_undos_staff_read ON public.lot_removal_undos;
CREATE POLICY lot_removal_undos_staff_read ON public.lot_removal_undos
  FOR SELECT USING (operator_id = (SELECT current_operator_id()));

-- ----------------------------------------------------------------------------
-- Shared check: signed-in staff of the lot's operator with an allowed role,
-- typed name and reason present. Internal (no grants).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lot_staff_action_check(
  p_operator_id UUID, p_staff_name TEXT, p_reason TEXT, p_roles TEXT[])
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN 'not_authenticated';
  END IF;
  SELECT ou.role::text INTO v_role FROM operator_users ou
   WHERE ou.user_id = auth.uid() AND ou.operator_id = p_operator_id;
  IF v_role IS NULL THEN
    RETURN 'lot_other_operator';
  END IF;
  IF NOT (v_role = ANY (p_roles)) THEN
    RETURN CASE WHEN p_roles = ARRAY['admin'] THEN 'admin_required' ELSE 'admin_or_manager_required' END;
  END IF;
  IF nullif(btrim(coalesce(p_staff_name, '')), '') IS NULL OR length(btrim(p_staff_name)) > 100 THEN
    RETURN 'staff_name_required';
  END IF;
  IF nullif(btrim(coalesce(p_reason, '')), '') IS NULL OR length(btrim(p_reason)) > 500 THEN
    RETURN 'reason_required';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.lot_staff_action_check(UUID, TEXT, TEXT, TEXT[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.lot_staff_action_check(UUID, TEXT, TEXT, TEXT[]) FROM anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (3) withdraw_lot_from_auction
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.withdraw_lot_from_auction(
  p_lot_id UUID, p_staff_name TEXT, p_reason TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lot     lots%ROWTYPE;
  v_err     TEXT;
  v_id      UUID;
  v_n       INTEGER := 0;
  v_bidder  UUID;
  v_title   TEXT;
BEGIN
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  v_err := public.lot_staff_action_check(v_lot.operator_id, p_staff_name, p_reason, ARRAY['admin', 'manager']);
  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_err);
  END IF;

  IF v_lot.status = 'won' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_won');
  END IF;
  IF v_lot.status NOT IN ('scheduled', 'live') OR v_lot.auction_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_in_open_auction', 'status', v_lot.status);
  END IF;
  IF v_lot.removal_kind IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_removed');
  END IF;
  IF EXISTS (
    SELECT 1 FROM invoice_lots il JOIN invoices i ON i.id = il.invoice_id
     WHERE il.lot_id = p_lot_id AND il.refunded_at IS NULL
       AND i.status NOT IN ('canceled', 'refunded')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_on_invoice');
  END IF;

  SELECT title INTO v_title FROM auctions WHERE id = v_lot.auction_id;

  INSERT INTO lot_withdrawals (
    lot_id, operator_id, auction_id, lot_number, close_at, prior_status,
    current_bid_cents, current_bid_id, winner_bidder_id, bid_count,
    staff_name, reason, withdrawn_by)
  VALUES (
    p_lot_id, v_lot.operator_id, v_lot.auction_id, v_lot.lot_number, v_lot.close_at, v_lot.status::text,
    v_lot.current_bid_cents, v_lot.current_bid_id, v_lot.winner_bidder_id, coalesce(v_lot.bid_count, 0),
    btrim(p_staff_name), btrim(p_reason), auth.uid())
  RETURNING id INTO v_id;

  -- Same shape as admin_cancel_lot: the lot leaves the auction. Bids stay.
  UPDATE lots
     SET status           = 'canceled',
         auction_id       = NULL,
         lot_number       = NULL,
         close_at         = NULL,
         current_bid_id   = NULL,
         winner_bidder_id = NULL,
         current_bid_cents = NULL,
         canceled_at      = now(),
         canceled_by      = auth.uid(),
         updated_at       = now()
   WHERE id = p_lot_id;

  -- Push / in-app only (no email template, not on the SMS allow-list).
  FOR v_bidder IN SELECT DISTINCT b.bidder_id FROM bids b WHERE b.lot_id = p_lot_id LOOP
    PERFORM public.enqueue_notification(
      'lot_withdrawn'::notification_kind, v_bidder,
      jsonb_build_object('lot_id', p_lot_id, 'lot_title', v_lot.title, 'lot_code', v_lot.lot_code,
                         'auction_title', v_title, 'deep_link', '/lot/' || p_lot_id),
      'lot_withdrawn:' || v_id || ':' || v_bidder);
    v_n := v_n + 1;
  END LOOP;
  UPDATE lot_withdrawals SET bidders_notified = v_n WHERE id = v_id;

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES (v_lot.operator_id, auth.uid(), 'lot.withdrawn', p_lot_id,
          jsonb_build_object('status', v_lot.status, 'auction_id', v_lot.auction_id, 'lot_number', v_lot.lot_number,
                             'close_at', v_lot.close_at, 'current_bid_cents', v_lot.current_bid_cents,
                             'bid_count', v_lot.bid_count),
          jsonb_build_object('status', 'canceled', 'withdrawal_id', v_id, 'bidders_notified', v_n,
                             'staff_name', btrim(p_staff_name)),
          btrim(p_staff_name) || ': ' || btrim(p_reason));

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id, 'withdrawal_id', v_id,
                            'bid_count', coalesce(v_lot.bid_count, 0), 'bidders_notified', v_n);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.withdraw_lot_from_auction(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.withdraw_lot_from_auction(UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.withdraw_lot_from_auction(UUID, TEXT, TEXT) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (4) undo_lot_withdrawal
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.undo_lot_withdrawal(
  p_lot_id UUID, p_staff_name TEXT, p_reason TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lot     lots%ROWTYPE;
  w         lot_withdrawals%ROWTYPE;
  v_err     TEXT;
  v_auction auctions%ROWTYPE;
  v_bidder  UUID;
  v_n       INTEGER := 0;
BEGIN
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  v_err := public.lot_staff_action_check(v_lot.operator_id, p_staff_name, p_reason, ARRAY['admin', 'manager']);
  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_err);
  END IF;

  SELECT * INTO w FROM lot_withdrawals WHERE lot_id = p_lot_id AND undone_at IS NULL FOR UPDATE;
  IF w.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_withdrawn');
  END IF;
  IF v_lot.status <> 'canceled' OR v_lot.removal_kind IS NOT NULL OR v_lot.auction_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_changed_since_withdrawal', 'status', v_lot.status);
  END IF;

  SELECT * INTO v_auction FROM auctions WHERE id = w.auction_id FOR SHARE;
  IF v_auction.id IS NULL OR v_auction.status NOT IN ('scheduled', 'live')
     OR w.close_at IS NULL OR w.close_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'auction_closed');
  END IF;
  IF w.lot_number IS NOT NULL AND EXISTS (
    SELECT 1 FROM lots l WHERE l.auction_id = w.auction_id AND l.lot_number = w.lot_number AND l.id <> p_lot_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_number_taken', 'lot_number', w.lot_number);
  END IF;

  UPDATE lots
     SET status            = w.prior_status::lot_status,
         auction_id        = w.auction_id,
         lot_number        = w.lot_number,
         close_at          = w.close_at,
         current_bid_cents = w.current_bid_cents,
         current_bid_id    = w.current_bid_id,
         winner_bidder_id  = w.winner_bidder_id,
         updated_at        = now()
   WHERE id = p_lot_id;

  UPDATE lot_withdrawals
     SET undone_at = now(), undone_by = auth.uid(),
         undo_staff_name = btrim(p_staff_name), undo_reason = btrim(p_reason)
   WHERE id = w.id;

  FOR v_bidder IN SELECT DISTINCT b.bidder_id FROM bids b WHERE b.lot_id = p_lot_id LOOP
    PERFORM public.enqueue_notification(
      'lot_reinstated'::notification_kind, v_bidder,
      jsonb_build_object('lot_id', p_lot_id, 'lot_title', v_lot.title, 'lot_code', v_lot.lot_code,
                         'auction_title', v_auction.title, 'deep_link', '/lot/' || p_lot_id),
      'lot_reinstated:' || w.id || ':' || v_bidder);
    v_n := v_n + 1;
  END LOOP;

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES (v_lot.operator_id, auth.uid(), 'lot.withdrawal_undone', p_lot_id,
          jsonb_build_object('status', 'canceled', 'withdrawal_id', w.id),
          jsonb_build_object('status', w.prior_status, 'auction_id', w.auction_id, 'lot_number', w.lot_number,
                             'close_at', w.close_at, 'bidders_notified', v_n, 'staff_name', btrim(p_staff_name)),
          btrim(p_staff_name) || ': ' || btrim(p_reason));

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id, 'status', w.prior_status, 'bidders_notified', v_n);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.undo_lot_withdrawal(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.undo_lot_withdrawal(UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.undo_lot_withdrawal(UUID, TEXT, TEXT) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (5) keep_lot_for_business: 0381 body; a withdrawn (canceled) lot may be kept
-- ----------------------------------------------------------------------------
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

  -- 0471: a canceled lot is a real item on a shelf -- withdrawn with
  -- withdraw_lot_from_auction, pulled with admin_cancel_lot, or canceled
  -- before it opened -- and may be kept. (The stamps cannot tell the cancel
  -- paths apart, so the rule is: canceled, not hard-deleted.) A sold lot is
  -- still refused by the invoice check below.
  IF v_lot.status = 'canceled' AND v_lot.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_canceled');
  END IF;
  IF v_lot.status = 'disposed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_disposed');
  END IF;
  -- 0471: a won lot may be kept only when its sale is undone: it has invoice
  -- lines and every one is refunded or on a canceled / refunded invoice. A
  -- won lot with no invoice line yet is a sale in progress -> refused.
  IF v_lot.status = 'won' AND (
       NOT EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = p_lot_id)
       OR EXISTS (
         SELECT 1 FROM invoice_lots il JOIN invoices i ON i.id = il.invoice_id
          WHERE il.lot_id = p_lot_id AND il.refunded_at IS NULL
            AND i.status NOT IN ('canceled', 'refunded'))) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_on_invoice');
  END IF;

  IF v_lot.status IN ('scheduled', 'live') THEN
    SELECT count(*)::INT INTO v_bids FROM bids WHERE lot_id = p_lot_id;
    IF v_bids > 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'lot_live_with_bids', 'bids', v_bids);
    END IF;
  END IF;

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

-- Same grants as 0381 (restated; CREATE OR REPLACE keeps them anyway).
REVOKE EXECUTE ON FUNCTION public.keep_lot_for_business(UUID, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.keep_lot_for_business(UUID, INTEGER, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.keep_lot_for_business(UUID, INTEGER, TEXT) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (6) Console Dispose / Business use with typed name + reason
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispose_lot_attributed(
  p_lot_id UUID, p_kind TEXT, p_staff_name TEXT, p_reason TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_op  UUID;
  v_err TEXT;
  v_res jsonb;
BEGIN
  SELECT operator_id INTO v_op FROM lots WHERE id = p_lot_id;
  IF v_op IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  v_err := public.lot_staff_action_check(v_op, p_staff_name, p_reason, ARRAY['admin', 'manager']);
  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_err);
  END IF;
  v_res := public.remove_lot_from_inventory(p_lot_id, p_kind, left(btrim(p_staff_name) || ': ' || btrim(p_reason), 1000));
  IF (v_res->>'ok')::boolean AND NOT coalesce((v_res->>'idempotent')::boolean, false) THEN
    INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
    VALUES (v_op, auth.uid(), 'lot.removed_from_inventory', p_lot_id, NULL,
            jsonb_build_object('removal_kind', p_kind, 'staff_name', btrim(p_staff_name)),
            btrim(p_staff_name) || ': ' || btrim(p_reason));
  END IF;
  RETURN v_res;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.dispose_lot_attributed(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.dispose_lot_attributed(UUID, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.dispose_lot_attributed(UUID, TEXT, TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.keep_lot_for_business_attributed(
  p_lot_id UUID, p_price_cents INTEGER, p_staff_name TEXT, p_reason TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_op  UUID;
  v_err TEXT;
  v_res jsonb;
BEGIN
  SELECT operator_id INTO v_op FROM lots WHERE id = p_lot_id;
  IF v_op IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  v_err := public.lot_staff_action_check(v_op, p_staff_name, p_reason, ARRAY['admin', 'manager']);
  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_err);
  END IF;
  -- keep_lot_for_business caps its reason at 500 characters.
  v_res := public.keep_lot_for_business(p_lot_id, p_price_cents, left(btrim(p_staff_name) || ': ' || btrim(p_reason), 500));
  RETURN v_res;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.keep_lot_for_business_attributed(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.keep_lot_for_business_attributed(UUID, INTEGER, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.keep_lot_for_business_attributed(UUID, INTEGER, TEXT, TEXT) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (7) undo_lot_removal: admin only, within 24 h
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.undo_lot_removal(
  p_lot_id UUID, p_staff_name TEXT, p_reason TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lot    lots%ROWTYPE;
  v_err    TEXT;
  v_prior  TEXT;
  v_to     TEXT;
  v_keep   jsonb;
  v_out_of_auction BOOLEAN;
BEGIN
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  v_err := public.lot_staff_action_check(v_lot.operator_id, p_staff_name, p_reason, ARRAY['admin']);
  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_err);
  END IF;
  IF v_lot.removal_kind IS NULL OR v_lot.status <> 'disposed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_removed');
  END IF;
  IF v_lot.removed_at IS NULL OR v_lot.removed_at <= now() - INTERVAL '24 hours' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'undo_window_passed', 'removed_at', v_lot.removed_at);
  END IF;

  SELECT h.from_status INTO v_prior FROM lot_status_history h
   WHERE h.lot_id = p_lot_id AND h.to_status = 'disposed'
   ORDER BY h.changed_at DESC, h.id DESC LIMIT 1;
  SELECT to_jsonb(k) INTO v_keep FROM lot_internal_keeps k WHERE k.lot_id = p_lot_id;
  v_prior := coalesce(v_prior, v_keep->>'prior_status', 'in_inventory');

  -- pending_intake / in_inventory / unsold / relisted / canceled return to
  -- that status as they were. Anything else (draft, scheduled, live, a won
  -- lot whose sale was undone) comes back to in_inventory OUTSIDE any auction:
  -- that auction moved on, and a won lot must never become 'won' again.
  v_out_of_auction := v_prior NOT IN ('pending_intake', 'in_inventory', 'unsold', 'relisted', 'canceled');
  v_to := CASE WHEN v_out_of_auction THEN 'in_inventory' ELSE v_prior END;

  -- Proof for lots_removal_is_terminal: this transaction is an admin undo.
  INSERT INTO lot_removal_undos (lot_id, operator_id, removal_kind, removal_note, removed_at, removed_by,
                                 kept_row, restored_status, staff_name, reason, undone_by)
  VALUES (p_lot_id, v_lot.operator_id, v_lot.removal_kind, v_lot.removal_note, v_lot.removed_at, v_lot.removed_by,
          v_keep, v_to, btrim(p_staff_name), btrim(p_reason), auth.uid());

  UPDATE lots
     SET status               = v_to::lot_status,
         removal_kind         = NULL,
         removed_at           = NULL,
         removed_by           = NULL,
         removal_note         = NULL,
         flagged_for_disposal = CASE WHEN flagged_reason LIKE 'removed: %' OR flagged_reason = 'kept for business'
                                     THEN FALSE ELSE flagged_for_disposal END,
         flagged_reason       = CASE WHEN flagged_reason LIKE 'removed: %' OR flagged_reason = 'kept for business'
                                     THEN NULL ELSE flagged_reason END,
         flagged_at           = CASE WHEN flagged_reason LIKE 'removed: %' OR flagged_reason = 'kept for business'
                                     THEN NULL ELSE flagged_at END,
         auction_id           = CASE WHEN v_out_of_auction THEN NULL ELSE auction_id END,
         lot_number           = CASE WHEN v_out_of_auction THEN NULL ELSE lot_number END,
         close_at             = CASE WHEN v_out_of_auction THEN NULL ELSE close_at END,
         updated_at           = now()
   WHERE id = p_lot_id;

  DELETE FROM lot_internal_keeps WHERE lot_id = p_lot_id;

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES (v_lot.operator_id, auth.uid(), 'lot.removal_undone', p_lot_id,
          jsonb_build_object('status', 'disposed', 'removal_kind', v_lot.removal_kind, 'removal_note', v_lot.removal_note,
                             'removed_at', v_lot.removed_at, 'kept', v_keep),
          jsonb_build_object('status', v_to, 'staff_name', btrim(p_staff_name)),
          btrim(p_staff_name) || ': ' || btrim(p_reason));

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id, 'status', v_to, 'was_kept', v_keep IS NOT NULL);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.undo_lot_removal(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.undo_lot_removal(UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.undo_lot_removal(UUID, TEXT, TEXT) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (8) lots_removal_is_terminal: 0319 rule, plus the one admin-undo exception
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lots_removal_is_terminal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.removal_kind IS NULL THEN
    RETURN NEW;
  END IF;

  -- 0471: an admin undo within 24 h (undo_lot_removal) writes a
  -- lot_removal_undos row in THIS transaction first. Only then may the
  -- removal be cleared, and only all the way back (kind NULL, not disposed).
  IF NEW.removal_kind IS NULL AND NEW.status <> 'disposed'
     AND EXISTS (SELECT 1 FROM lot_removal_undos u
                  WHERE u.lot_id = OLD.id AND u.txid = txid_current()) THEN
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

REVOKE EXECUTE ON FUNCTION public.lots_removal_is_terminal() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.lots_removal_is_terminal() FROM anon, authenticated;

COMMIT;
