-- 0444 — undo_invoice_line_forfeit(): a console "Undo forfeit" for one line,
--        admin/manager only, reason and staff name required, audited.
--
-- WHY
--
-- The no-show sweep stamps every still-open line of a forfeited pickup
-- (0301 trigger). Once stamped, the refund route refuses the line
-- (lot_forfeited), the refund form greys it out, and the #524 pickup override
-- only offers it while the lot was never relisted. The only way back was a
-- one-off migration per line (0395). Staff report 2026-10-22: three lines
-- (one forfeited while the customer was at the counter mid-handover) that
-- staff need to refund or mark picked up.
--
-- Owner decision 2026-10-22 (Jared/Braden): staff may undo forfeits and refund
-- forfeited items. BinGo's floor shares one admin console login, so the audit
-- row carries a typed staff name as well as the account.
--
-- WHAT
--
-- public.undo_invoice_line_forfeit(p_invoice_id, p_lot_id, p_purpose,
--                                  p_reason, p_done_by) RETURNS jsonb
--
--   p_purpose  'refund' or 'picked_up' (what staff will do next; recorded)
--   p_reason   why, at least 5 characters
--   p_done_by  the person's name, at least 2 characters
--
-- In ONE transaction:
--   1. clears invoice_lots.forfeited_at on that line;
--   2. puts the lot back to 'won' (from unsold / relisted / in_inventory), so
--      the invoice page reads the line as owed again and the normal refund or
--      picked-up action runs. Exception: a REFUND while a relist lot of the
--      item is still alive leaves the lot alone (the box stays in the
--      warehouse and its relist keeps running; owner, 2026-10-22, TEA4841836);
--   3. writes operator_audit_log 'invoice_line.forfeit_undone' (target_id =
--      invoice id, like refunds and forfeits): who (account), done_by (typed
--      name), when, why, purpose, and the old forfeited_at, lot status and
--      pickup status.
--
-- No money moves here. A refund still goes through /api/invoices/[id]/
-- refund-items and its checks.
--
-- REFUSES (returns {ok:false, code}, changes nothing):
--   forbidden            caller is not admin/manager of the invoice's operator
--   bad_purpose          purpose not 'refund' / 'picked_up'
--   reason_required      reason shorter than 5 characters
--   name_required        staff name shorter than 2 characters
--   not_found            no such line on this invoice
--   invoice_not_paid     invoice not paid / partially_refunded
--   not_forfeited        line is not forfeited
--   already_refunded     line already refunded
--   already_picked_up    line already picked up
--   relist_child_live    PICKED UP only: the item was relisted and a relist
--                        lot (any generation) is not canceled or deleted. The
--                        box cannot have gone home while it is listed again;
--                        pull the relist first (Cancel lot). A REFUND is
--                        allowed with a live relist: the first buyer gets
--                        their money back and the relist keeps the box
--                        (owner, 2026-10-22).
--   lot_status           lot is in a state this must not touch (e.g.
--                        disposed, scheduled, live, sold to someone)
--
-- Not changed: the pickups row keeps status 'forfeited' (history). The #524
-- override completes it if staff mark the item picked up; the sweep never
-- revisits a forfeited pickup.
--
-- ROLLBACK: scripts/prod-rig/0444_ROLLBACK_undo_invoice_line_forfeit.sql drops
-- the function. Lines already un-forfeited stay un-forfeited; each one's old
-- forfeited_at and lot status are in its audit row's before_state.

SET lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.undo_invoice_line_forfeit(
  p_invoice_id uuid,
  p_lot_id     uuid,
  p_purpose    text,
  p_reason     text,
  p_done_by    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_staff     record;
  v_line      record;
  v_lot       record;
  v_pickup    text;
  v_child     record;
  v_reason    text := btrim(coalesce(p_reason, ''));
  v_done_by   text := btrim(coalesce(p_done_by, ''));
  v_n         int;
  v_child_live boolean;
  v_new_status text;
BEGIN
  SELECT operator_id, role::text AS role INTO v_staff
    FROM operator_users WHERE user_id = v_uid;
  IF v_uid IS NULL OR NOT FOUND OR v_staff.role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;
  IF p_purpose IS NULL OR p_purpose NOT IN ('refund', 'picked_up') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_purpose');
  END IF;
  IF length(v_reason) < 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'reason_required');
  END IF;
  IF length(v_done_by) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'name_required');
  END IF;

  SELECT il.forfeited_at, il.refunded_at, il.picked_up_at,
         i.operator_id, i.status::text AS inv_status, i.paid_at
    INTO v_line
    FROM invoice_lots il JOIN invoices i ON i.id = il.invoice_id
   WHERE il.invoice_id = p_invoice_id AND il.lot_id = p_lot_id
   FOR UPDATE OF il;
  IF NOT FOUND OR v_line.operator_id IS DISTINCT FROM v_staff.operator_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_line.paid_at IS NULL OR v_line.inv_status NOT IN ('paid', 'partially_refunded') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invoice_not_paid');
  END IF;
  IF v_line.refunded_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_refunded');
  END IF;
  IF v_line.picked_up_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_picked_up');
  END IF;
  IF v_line.forfeited_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_forfeited');
  END IF;

  SELECT id, lot_code, status::text AS status INTO v_lot
    FROM lots WHERE id = p_lot_id FOR UPDATE;

  -- Any relist descendant still alive (not canceled, not deleted) means the
  -- box is listed again. It cannot have gone home, so picked up is refused
  -- until staff pull the relist. A refund may go ahead; the relist keeps it.
  WITH RECURSIVE kin AS (
    SELECT c.id, c.lot_code, c.status::text AS status, c.auction_id, c.deleted_at, 1 AS depth
      FROM lots c WHERE c.relisted_from_lot_id = p_lot_id
    UNION ALL
    SELECT g.id, g.lot_code, g.status::text, g.auction_id, g.deleted_at, k.depth + 1
      FROM lots g JOIN kin k ON g.relisted_from_lot_id = k.id
     WHERE k.depth < 10
  )
  SELECT lot_code, status, auction_id INTO v_child
    FROM kin
   WHERE deleted_at IS NULL AND status <> 'canceled'
   ORDER BY depth
   LIMIT 1;
  v_child_live := FOUND;
  IF v_child_live AND p_purpose = 'picked_up' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'relist_child_live',
      'child_lot_code', v_child.lot_code, 'child_status', v_child.status,
      'child_auction_id', v_child.auction_id);
  END IF;

  IF v_lot.status NOT IN ('won', 'unsold', 'relisted', 'in_inventory') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'lot_status', 'lot_status', v_lot.status);
  END IF;

  SELECT status::text INTO v_pickup
    FROM pickups WHERE invoice_id = p_invoice_id
   ORDER BY created_at DESC LIMIT 1;

  UPDATE invoice_lots SET forfeited_at = NULL
   WHERE invoice_id = p_invoice_id AND lot_id = p_lot_id
     AND forfeited_at = v_line.forfeited_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0444: expected 1 line, updated %', v_n;
  END IF;

  -- A live relist keeps the box: leave the lot as it is (refund only, above).
  v_new_status := CASE WHEN v_child_live THEN v_lot.status ELSE 'won' END;
  IF v_new_status <> v_lot.status THEN
    UPDATE lots SET status = 'won', updated_at = now() WHERE id = p_lot_id;
  END IF;

  INSERT INTO operator_audit_log
    (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES
    (v_line.operator_id, v_uid, 'invoice_line.forfeit_undone', p_invoice_id,
     jsonb_build_object('lot_id', p_lot_id, 'lot_code', v_lot.lot_code,
                        'forfeited_at', v_line.forfeited_at,
                        'lot_status', v_lot.status, 'pickup_status', v_pickup),
     jsonb_build_object('lot_id', p_lot_id, 'forfeited_at', NULL,
                        'lot_status', v_new_status, 'purpose', p_purpose,
                        'done_by', v_done_by,
                        'relist_kept', CASE WHEN v_child_live THEN v_child.lot_code END),
     v_reason);

  RETURN jsonb_build_object('ok', true, 'purpose', p_purpose,
                            'lot_code', v_lot.lot_code,
                            'old_forfeited_at', v_line.forfeited_at,
                            'old_lot_status', v_lot.status,
                            'lot_status', v_new_status,
                            'relist_kept', CASE WHEN v_child_live THEN v_child.lot_code END);
END;
$function$;

COMMENT ON FUNCTION public.undo_invoice_line_forfeit(uuid, uuid, text, text, text) IS
  '0444: clears one line''s forfeit and puts its lot back to won, so staff can '
  'refund it or mark it picked up through the normal paths. Admin/manager; '
  'reason and staff name required. Picked up is refused while any relist lot '
  'is still alive; a refund leaves a live relist and the lot alone. Audited '
  'as invoice_line.forfeit_undone. Moves no money.';

REVOKE ALL ON FUNCTION public.undo_invoice_line_forfeit(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.undo_invoice_line_forfeit(uuid, uuid, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.undo_invoice_line_forfeit(uuid, uuid, text, text, text) TO authenticated, service_role;
