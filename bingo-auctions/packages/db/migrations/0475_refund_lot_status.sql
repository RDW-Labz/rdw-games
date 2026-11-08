-- ============================================================================
-- Migration 0475 — a fully refunded sale moves the lot to a new status
-- 'refunded'; relist after refund needs a manager PIN.
--
-- Why (read-only prod check, 2026-10-28, TEA4842561 / BIN-034795): the staff
-- item refund (refund-items route) stamps invoice_lots.refunded_at, updates
-- the invoice and closes the pickup, but never touches the lot. A refunded
-- lot stays 'won' forever: the console shows it sold, offers no relist, and
-- lookups keep naming the buyer. Prod: 580 lots have a refunded line and are
-- still 'won' (565 in the last 90 days).
--
-- Owner decisions 2026-10-28:
--   - after a full refund the lot moves to a NEW status 'refunded'; the
--     refund and the buyer stay in history (invoice_lots, winner_bidder_id,
--     lot_status_history are untouched);
--   - the 580 existing lots are NOT changed here (read-only list in
--     scripts/prod-rig/0475-rig/backfill-candidates.sql; any data step only
--     after the owner approves a batch);
--   - relist after refund with a manager PIN, typed staff name and reason.
--
-- New:
--   lot_status value 'refunded'.
--   invoice_lots_0475_refund_to_refunded  CONSTRAINT trigger, AFTER UPDATE OF
--     refunded_at ON invoice_lots, DEFERRED to commit, only when refunded_at
--     goes NULL -> set. Moves the lot
--     won -> refunded when ALL hold, else changes nothing:
--       - the line is FULLY refunded (invoice refunded, or item refunds +
--         0474 overrides for this line >= what it was paid, 2c rounding);
--         a partial refund for damage does not move the lot;
--       - the lot is 'won';
--       - the line was never picked up (the buyer took it home otherwise);
--       - the line was not forfeited (no-show path owns that lot);
--       - the line was not reported missing at pickup (0393 'missing');
--       - no other line for this lot is still an open sale.
--     Audited: operator_audit_log 'lot.refunded'.
--   relist_refunded_lot(lot, manager_worker, pin, staff_name, reason, auction)
--     Relist (or relot to inventory, auction NULL) a lot whose sale was
--     refunded: status 'refunded', or a legacy 'won' lot whose every line is
--     refunded. Manager/admin worker PIN (verify_worker_pin, 0281, with its
--     lockout), typed name and reason; audited 'lot.relist_after_refund'.
--     relist_lot_into_auction is NOT changed: this function moves the lot
--     refunded -> unsold inside the same transaction and then calls it, so
--     every existing relist guard still applies (history shows
--     refunded -> unsold -> relisted).
--   lots_bidder_read_published: 'refunded' added to the statuses bidders
--     may read (otherwise the lot vanishes from My Bids, invoices, pickup
--     and results for every bidder, the buyer included). Nothing else in
--     the policy changes; a preflight refuses if prod's policy differs.
--
-- Who sees 'refunded' (full list in scripts/prod-rig/0475-rig/STATUS-SCREENS.md):
--   auto_relist_unsold_lots picks only 'unsold', so refunded lots never
--   auto-relist (they need the PIN). The staff app's Relot screen calls
--   relist_lot_into_auction directly and refuses a 'refunded' lot
--   ("relist_source_wrong_status") until it calls relist_refunded_lot.
--
-- LOCKS / WINDOW
--   ALTER TYPE ... ADD VALUE: brief lock on the enum type. CREATE TRIGGER on
--   invoice_lots: SHARE ROW EXCLUSIVE for milliseconds (refunds and invoice
--   building wait). DROP/CREATE POLICY on lots: ACCESS EXCLUSIVE on lots for
--   milliseconds, taken last (every lot read waits meanwhile; if a long
--   reader holds lots, lock_timeout cancels the whole transaction cleanly).
--   lock_timeout 3s. Window 05:00-07:00 CT, not before Wed 2026-11-04 (owner).
--   The enum value is added in its OWN transaction (committed first), then
--   the trigger and function in a second one. If transaction 2 fails, the
--   unused 'refunded' value stays (harmless) and a re-run completes it.
--
-- Idempotent: ADD VALUE IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF
-- EXISTS + CREATE, DROP POLICY IF EXISTS + CREATE (preflight accepts the
-- pre-0475 and the 0475 policy).
-- Rollback: scripts/prod-rig/0475_ROLLBACK_refund_lot_status.sql (cannot
-- remove an enum value; see that file).
-- ============================================================================

-- Transaction 1: the enum value on its own, so it is committed before
-- anything below uses it.
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TYPE public.lot_status ADD VALUE IF NOT EXISTS 'refunded';
COMMIT;

-- Transaction 2: trigger + relist function + bidder read policy.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. Refund -> refunded
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invoice_lots_0475_refund_to_refunded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot       lots%ROWTYPE;
  v_line      invoice_lots%ROWTYPE;
  v_inv       invoices%ROWTYPE;
  v_line_paid BIGINT;
  v_refunded  BIGINT := 0;
  v_extra     BIGINT := 0;
BEGIN
  -- Deferred to commit, so re-read the line as it is now.
  SELECT * INTO v_line FROM invoice_lots WHERE invoice_id = NEW.invoice_id AND lot_id = NEW.lot_id;
  IF NOT FOUND OR v_line.refunded_at IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_lot FROM lots WHERE id = NEW.lot_id FOR UPDATE;
  IF NOT FOUND OR v_lot.status::text <> 'won' OR v_lot.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  -- The buyer took it home: it is not back in stock.
  IF v_line.picked_up_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  -- A forfeited line belongs to the no-show path (which already moves the
  -- lot on); a later refund of it changes nothing here.
  IF v_line.forfeited_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  -- Only a FULL refund of the line. The item refund stamps refunded_at for
  -- any amount, so a partial refund (e.g. a few dollars for damage) must not
  -- move the lot. Full = the invoice is fully refunded, or the money
  -- recorded for this line (item refunds in operator_audit_log, plus 0474
  -- refund overrides when that table exists) reaches what the line was paid
  -- (hammer + its share of premium and tax, the refund-math formula), less
  -- 2 cents of rounding.
  SELECT * INTO v_inv FROM invoices WHERE id = NEW.invoice_id;
  IF v_inv.status::text <> 'refunded' THEN
    IF coalesce(v_inv.subtotal_cents, 0) <= 0 THEN
      v_line_paid := v_line.winning_bid_cents;
    ELSE
      v_line_paid := v_line.winning_bid_cents
        + round(coalesce(v_inv.buyer_premium_cents, 0)::numeric * v_line.winning_bid_cents / v_inv.subtotal_cents)
        + round(coalesce(v_inv.tax_cents, 0)::numeric * v_line.winning_bid_cents / v_inv.subtotal_cents);
    END IF;
    SELECT coalesce(sum((a.after_state->>'amount_cents')::bigint), 0) INTO v_refunded
      FROM operator_audit_log a
     WHERE a.target_id = NEW.invoice_id
       AND a.action_type = 'invoice.refund_item'
       AND a.after_state->>'lot_id' = NEW.lot_id::text;
    IF to_regclass('public.refund_overrides') IS NOT NULL THEN
      EXECUTE 'SELECT coalesce(sum(amount_cents), 0) FROM public.refund_overrides WHERE invoice_id = $1 AND lot_id = $2'
        INTO v_extra USING NEW.invoice_id, NEW.lot_id;
    END IF;
    IF v_refunded + v_extra < v_line_paid - 2 THEN
      RETURN NULL;
    END IF;
  END IF;
  -- Reported missing at pickup (0393): not on a shelf.
  IF EXISTS (
    SELECT 1 FROM pickup_lot_outcomes o JOIN pickups p ON p.id = o.pickup_id
     WHERE p.invoice_id = NEW.invoice_id AND o.lot_id = NEW.lot_id AND o.outcome = 'missing'
  ) THEN
    RETURN NULL;
  END IF;
  -- Another sale of this lot is still open.
  IF EXISTS (
    SELECT 1 FROM invoice_lots il JOIN invoices i ON i.id = il.invoice_id
     WHERE il.lot_id = NEW.lot_id
       AND il.invoice_id <> NEW.invoice_id
       AND il.refunded_at IS NULL AND il.forfeited_at IS NULL
       AND i.status IN ('pending', 'paid', 'partially_refunded', 'payment_failed_grace')
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE lots SET status = 'refunded'::lot_status, updated_at = now() WHERE id = NEW.lot_id;

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES (v_lot.operator_id, auth.uid(), 'lot.refunded', NEW.lot_id,
          jsonb_build_object('status', 'won', 'invoice_id', NEW.invoice_id),
          jsonb_build_object('status', 'refunded', 'refunded_at', NEW.refunded_at),
          'Sale fully refunded and not picked up (0475)');
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.invoice_lots_0475_refund_to_refunded() FROM PUBLIC;

COMMENT ON FUNCTION public.invoice_lots_0475_refund_to_refunded() IS
  '0475: a refunded invoice line whose lot is won, never picked up, not '
  'reported missing and has no other open sale moves the lot to refunded.';

-- A CONSTRAINT trigger, deferred to commit: the 0474 override records its
-- refund_overrides row after it stamps the line, in the same transaction.
DROP TRIGGER IF EXISTS invoice_lots_0475_refund_to_refunded ON public.invoice_lots;
CREATE CONSTRAINT TRIGGER invoice_lots_0475_refund_to_refunded
  AFTER UPDATE OF refunded_at ON public.invoice_lots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.refunded_at IS NULL AND NEW.refunded_at IS NOT NULL)
  EXECUTE FUNCTION public.invoice_lots_0475_refund_to_refunded();

-- ---------------------------------------------------------------------------
-- 2. Relist after refund (manager PIN)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.relist_refunded_lot(
  p_lot_id            UUID,
  p_manager_worker_id UUID,
  p_pin               TEXT,
  p_staff_name        TEXT,
  p_reason            TEXT,
  p_auction_id        UUID DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name   TEXT := nullif(btrim(coalesce(p_staff_name, '')), '');
  v_why    TEXT := nullif(btrim(coalesce(p_reason, '')), '');
  v_lot    lots%ROWTYPE;
  v_pin    json;
  v_role   TEXT;
  v_child  UUID;
  v_code   TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  IF v_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'staff_name_required');
  END IF;
  IF v_why IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required');
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF NOT FOUND OR v_lot.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF (public._caller_operator_user(v_lot.operator_id)).id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  IF v_lot.status::text NOT IN ('refunded', 'won') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_status', 'status', v_lot.status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = v_lot.id AND il.refunded_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_refunded');
  END IF;
  IF v_lot.status::text = 'won' AND EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = v_lot.id AND il.refunded_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_fully_refunded');
  END IF;
  IF EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = v_lot.id AND il.picked_up_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'buyer_took_it');
  END IF;

  -- Manager PIN last, so a refused lot does not burn PIN attempts.
  v_pin := public.verify_worker_pin(p_manager_worker_id, coalesce(p_pin, ''));
  IF NOT coalesce((v_pin->>'ok')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pin_' || coalesce(v_pin->>'reason', 'bad_pin'));
  END IF;
  SELECT role::text INTO v_role FROM workers WHERE id = p_manager_worker_id AND operator_id = v_lot.operator_id;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pin_not_manager');
  END IF;

  -- relist_lot_into_auction accepts 'unsold' (and a fully refunded 'won');
  -- it is not changed, so a refunded lot passes through 'unsold' here.
  -- Inside the sub-block so a refused relist also undoes the step to 'unsold'.
  BEGIN
    IF v_lot.status::text = 'refunded' THEN
      UPDATE lots SET status = 'unsold'::lot_status, updated_at = now() WHERE id = v_lot.id;
    END IF;
    v_child := public.relist_lot_into_auction(v_lot.id, p_auction_id);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'relist_refused', 'detail', SQLERRM);
  END;
  IF v_child IS NULL THEN
    RAISE EXCEPTION 'relist_refunded_lot: relist returned no lot' USING ERRCODE = 'P0001';
  END IF;
  UPDATE lots SET relist_origin = 'human_relot' WHERE id = v_child RETURNING lot_code INTO v_code;

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES (v_lot.operator_id, auth.uid(), 'lot.relist_after_refund', v_child,
          jsonb_build_object('lot_id', v_lot.id, 'lot_code', v_lot.lot_code, 'status', v_lot.status),
          jsonb_build_object('lot_id', v_child, 'lot_code', v_code, 'auction_id', p_auction_id,
                             'staff_name', v_name, 'manager_worker_id', p_manager_worker_id,
                             'manager_name', v_pin->'worker'->>'display_name'),
          v_why);

  RETURN jsonb_build_object('ok', true, 'reason', 'ok_relisted', 'lot_id', v_child, 'lot_code', v_code,
                            'to_inventory', p_auction_id IS NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.relist_refunded_lot(UUID, UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.relist_refunded_lot(UUID, UUID, TEXT, TEXT, TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.relist_refunded_lot(UUID, UUID, TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.relist_refunded_lot(UUID, UUID, TEXT, TEXT, TEXT, UUID) IS
  '0475: relist / relot to inventory a lot whose sale was refunded. Manager '
  'worker PIN, typed staff name and reason required; audited.';

-- ---------------------------------------------------------------------------
-- 3. Bidders still see a refunded lot (owner go 2026-10-28)
-- ---------------------------------------------------------------------------
-- lots_bidder_read_published (0181) lists the statuses bidders may read.
-- Without 'refunded' a refunded lot vanishes for every bidder, the buyer
-- included: My Bids (inner join on lots) drops the win, invoice and pickup
-- lines lose their title, and auction results drop the lot. Same policy as
-- prod (read 2026-10-28, qual md5 b250d666...), with only 'refunded' added.
-- Last step of this transaction, so the lock on lots is held only briefly.
DO $$
DECLARE
  v_md5 TEXT;
BEGIN
  SELECT md5(pg_get_expr(p.polqual, p.polrelid)) INTO v_md5
    FROM pg_policy p
   WHERE p.polrelid = 'public.lots'::regclass AND p.polname = 'lots_bidder_read_published';
  IF v_md5 IS DISTINCT FROM 'b250d666540e8f077a6a5d72a1fd422f'
     AND v_md5 IS DISTINCT FROM '47a1fc5867fb1127177d0623e8ad814c' THEN
    RAISE EXCEPTION '0475: lots_bidder_read_published is not the version this migration was written against (md5 %). Nothing changed.', v_md5;
  END IF;
END;
$$;

DROP POLICY IF EXISTS lots_bidder_read_published ON public.lots;
CREATE POLICY lots_bidder_read_published ON public.lots
  FOR SELECT
  USING (
    (SELECT is_bidder())
    AND status IN ('scheduled', 'live', 'won', 'unsold', 'relisted', 'refunded')
    AND (
      early_access_until IS NULL
      OR early_access_until <= now()
      OR is_subscriber(operator_id)
    )
    AND (
      NOT EXISTS (
        SELECT 1 FROM operators o
        WHERE o.id = lots.operator_id
          AND o.is_demo
      )
      OR EXISTS (
        SELECT 1 FROM bidders b
        WHERE b.id = (SELECT auth.uid())
          AND b.is_reviewer
      )
    )
  );

COMMIT;
