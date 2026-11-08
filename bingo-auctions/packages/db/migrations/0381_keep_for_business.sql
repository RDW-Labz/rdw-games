-- 0381 — Keep for business, Phase 1: an admin keeps an item instead of
--        auctioning it, recorded at a staff-entered price and kept out of
--        customer sales.
--
-- ── WHAT IT DOES ─────────────────────────────────────────────────────────────
-- keep_lot_for_business(lot, price_cents, reason), admin or manager only:
--   * allowed from draft, pending_intake, in_inventory, unsold, relisted, and
--     scheduled / live with NO bids (Phase 1);
--   * the lot leaves the sale for good the same way "Remove from inventory"
--     does (0319): status 'disposed', removal_kind set, who/when/why stamped,
--     and lots_removal_is_terminal keeps it there. It can't be relisted, bid
--     on, closed (0376) or invoiced;
--   * one row in lot_internal_keeps (the price, reason, who, when, and what the
--     lot was before) and one operator_audit_log row.
-- No Square charge, no store credit, no customer account, no invoice. Every
-- revenue report counts invoices only, so a kept item never shows as a sale.
--
-- ── WHAT IT REFUSES (later phases, need sign-off) ────────────────────────────
--   * a scheduled / live lot with bids       -> lot_live_with_bids (Phase 3)
--   * a won lot, or any lot on an invoice line that isn't refunded
--                                            -> lot_on_invoice (Phase 2)
--   * canceled / disposed / already removed  -> lot_canceled / lot_disposed /
--                                               already_removed_as_<kind>
-- Keeping the same lot twice is a no-op (idempotent), not an error.
--
-- ── WHY removal_kind 'other' ─────────────────────────────────────────────────
-- A new removal kind needs lots_removal_kind_check swapped on lots, which takes
-- an ACCESS EXCLUSIVE lock on the busiest table (Rule 9: 05:00-07:00 only).
-- lot_internal_keeps is the record, so the kind is 'other' with the note
-- "kept for business: <reason>". A dedicated kind can follow in a lock window.
--
-- ── RACES ────────────────────────────────────────────────────────────────────
-- The lot row is locked FOR UPDATE before the bid count. place_bid locks the
-- same row, so a bid either lands first (keep then refuses) or finds the lot
-- disposed (lot_not_biddable). finalize_due_lots takes only live lots with
-- SKIP LOCKED; a lot kept first is no longer live, and one closed first is
-- unsold (no bids) and still keepable.
--
-- Rollback: DROP FUNCTION public.keep_lot_for_business(uuid, integer, text);
--           DROP TABLE public.lot_internal_keeps;
--   (lots already kept stay disposed — removal is permanent by design)

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.lot_internal_keeps (
  lot_id            UUID PRIMARY KEY REFERENCES public.lots(id) ON DELETE RESTRICT,
  operator_id       UUID NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  kept_price_cents  INTEGER NOT NULL CHECK (kept_price_cents >= 0 AND kept_price_cents <= 100000000),
  reason            TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  kept_by           UUID NOT NULL REFERENCES auth.users(id),
  kept_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  prior_status      lot_status NOT NULL,
  prior_auction_id  UUID,
  lot_code          TEXT,
  title             TEXT
);

COMMENT ON TABLE public.lot_internal_keeps IS
  '0381: items the business kept instead of auctioning, at a staff-entered '
  'price (can be 0). Not a sale: no invoice, no charge. Written only by '
  'keep_lot_for_business(); read by the operator''s admin and manager.';

CREATE INDEX IF NOT EXISTS lot_internal_keeps_operator_kept_at
  ON public.lot_internal_keeps (operator_id, kept_at DESC);

ALTER TABLE public.lot_internal_keeps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lot_internal_keeps_read ON public.lot_internal_keeps;
CREATE POLICY lot_internal_keeps_read ON public.lot_internal_keeps
  FOR SELECT TO authenticated
  USING (
    operator_id = public.current_operator_id()
    AND public.current_operator_role() IN ('admin', 'manager')
  );

REVOKE ALL ON public.lot_internal_keeps FROM PUBLIC, anon;
GRANT SELECT ON public.lot_internal_keeps TO authenticated;
GRANT ALL ON public.lot_internal_keeps TO service_role;

CREATE OR REPLACE FUNCTION public.keep_lot_for_business(
  p_lot_id      UUID,
  p_price_cents INTEGER,
  p_reason      TEXT
)
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

REVOKE EXECUTE ON FUNCTION public.keep_lot_for_business(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.keep_lot_for_business(uuid, integer, text) TO authenticated, service_role;
