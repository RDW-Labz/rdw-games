-- migration 0256 — Manager Manual Pickup Override
--
-- Owner request 2026-07-10: counter staff occasionally release items without
-- the scan path recording it (scanner glitch, dead QR, support-approved
-- exception). The system then still thinks the items are owed and the
-- no-show/forfeit/relot machinery can fire on merchandise that already left
-- the building. Managers need a dashboard control to mark item(s) — or the
-- whole invoice — picked up after the fact, with a mandatory reason and a
-- full audit trail.
--
-- manager_pickup_override(p_invoice_id, p_lot_ids, p_reason, p_note):
--   • Caller must be operator staff with role admin or manager (pickers use
--     the normal scan/manual-checkout flow on the iPad).
--   • Invoice must be paid or partially_refunded (never stamp an unpaid one).
--   • p_lot_ids NULL/empty = every still-owed lot on the invoice.
--   • Stamps invoice_lots.picked_up_at (idempotent — already-stamped and
--     refunded lots are skipped), flips any staged bin_assignments, and
--     completes the pickups row when nothing is owed anymore — EXACTLY the
--     0217/0245 staff_confirm_pickup semantics, so the refund window,
--     no-show sweep, and pickup-pass views all behave identically.
--   • ALWAYS writes operator_audit_log (action_type 'pickup.manager_override')
--     with actor, reason code, optional note, and the affected lot ids.
--   • Reasons: system_glitch | scanner_issue | support_approved | other
--     ('other' requires a note).
--
-- Returns jsonb: { ok, picked_count, already_count, remaining_count,
--                  pickup_completed, error? }

BEGIN;

CREATE OR REPLACE FUNCTION manager_pickup_override(
  p_invoice_id UUID,
  p_lot_ids    UUID[] DEFAULT NULL,
  p_reason     TEXT   DEFAULT NULL,
  p_note       TEXT   DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user         UUID := auth.uid();
  v_staff        RECORD;
  v_invoice      invoices%ROWTYPE;
  v_pickup       pickups%ROWTYPE;
  v_targets      UUID[];
  v_picked       UUID[];
  v_already_ct   INT := 0;
  v_remaining_ct INT := 0;
  v_completed    BOOLEAN := FALSE;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT operator_id, role INTO v_staff
    FROM operator_users WHERE user_id = v_user LIMIT 1;
  IF v_staff IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_operator_staff');
  END IF;
  IF v_staff.role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'manager_or_admin_only');
  END IF;

  IF p_reason IS NULL
     OR p_reason NOT IN ('system_glitch', 'scanner_issue', 'support_approved', 'other') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_reason');
  END IF;
  IF p_reason = 'other' AND (p_note IS NULL OR btrim(p_note) = '') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'note_required_for_other');
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invoice_not_found');
  END IF;
  IF v_invoice.operator_id <> v_staff.operator_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invoice_other_operator');
  END IF;
  -- paid OR partially_refunded — a per-item refund leaves the rest owed
  -- (0253); an unpaid/refunded/canceled invoice must never be stamped.
  IF v_invoice.status NOT IN ('paid', 'partially_refunded') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invoice_not_paid');
  END IF;

  -- Resolve targets: explicit lot ids (validated against the invoice), or
  -- every still-owed lot. Refunded lots are never stamped — they were
  -- credited back, not handed over.
  IF p_lot_ids IS NULL OR COALESCE(array_length(p_lot_ids, 1), 0) = 0 THEN
    SELECT COALESCE(array_agg(il.lot_id), ARRAY[]::UUID[]) INTO v_targets
    FROM invoice_lots il
    WHERE il.invoice_id = p_invoice_id
      AND il.picked_up_at IS NULL
      AND il.refunded_at IS NULL;
  ELSE
    SELECT COALESCE(array_agg(il.lot_id), ARRAY[]::UUID[]) INTO v_targets
    FROM invoice_lots il
    WHERE il.invoice_id = p_invoice_id
      AND il.lot_id = ANY(p_lot_ids)
      AND il.refunded_at IS NULL;
    IF COALESCE(array_length(v_targets, 1), 0) < COALESCE(array_length(p_lot_ids, 1), 0) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'lot_not_on_invoice_or_refunded');
    END IF;
  END IF;

  -- Per-lot stamp (idempotent) — mirrors 0245 staff_confirm_pickup.
  WITH flipped AS (
    UPDATE invoice_lots
       SET picked_up_at = now()
     WHERE invoice_id = p_invoice_id
       AND lot_id = ANY(v_targets)
       AND picked_up_at IS NULL
    RETURNING lot_id
  )
  SELECT COALESCE(array_agg(lot_id), ARRAY[]::UUID[]) INTO v_picked FROM flipped;
  v_already_ct := COALESCE(array_length(v_targets, 1), 0)
                - COALESCE(array_length(v_picked, 1), 0);

  -- Staging-board state: flip each stamped lot's latest STAGED assignment.
  UPDATE bin_assignments ba
     SET status = 'picked_up', picked_up_at = now()
   WHERE ba.status = 'staged'
     AND ba.id IN (
       SELECT DISTINCT ON (a2.lot_id) a2.id
       FROM bin_assignments a2
       WHERE a2.lot_id = ANY(v_picked)
       ORDER BY a2.lot_id, a2.assigned_at DESC
     );

  -- Complete or keep open — same rule as 0245 (refunded lots don't count).
  SELECT count(*) INTO v_remaining_ct
  FROM invoice_lots
  WHERE invoice_id = p_invoice_id
    AND picked_up_at IS NULL
    AND refunded_at IS NULL;

  SELECT * INTO v_pickup FROM pickups WHERE invoice_id = p_invoice_id LIMIT 1;
  IF FOUND AND v_pickup.status <> 'completed' THEN
    IF v_remaining_ct = 0 THEN
      UPDATE pickups
         SET checked_in_at = COALESCE(checked_in_at, now()),
             completed_at  = now(),
             status        = 'completed',
             updated_at    = now()
       WHERE id = v_pickup.id;
      v_completed := TRUE;
      -- Same dedupe key as staff_confirm_pickup, so the bidder never gets a
      -- second "pickup confirmed" if the scan path already fired one.
      PERFORM enqueue_notification(
        'pickup_confirmed',
        v_invoice.bidder_id,
        jsonb_build_object(
          'invoice_id', p_invoice_id,
          'lots_picked', COALESCE(array_length(v_picked, 1), 0),
          'lots_missing', 0
        ),
        'pickup_confirmed:staff:' || p_invoice_id::TEXT
      );
    ELSE
      UPDATE pickups
         SET checked_in_at = COALESCE(checked_in_at, now()),
             status        = 'checked_in',
             updated_at    = now()
       WHERE id = v_pickup.id;
    END IF;
  ELSIF FOUND AND v_pickup.status = 'completed' THEN
    v_completed := TRUE;
  END IF;

  -- Audit — the whole point of this override. Definer insert; the log has
  -- no client INSERT policy (0157).
  INSERT INTO operator_audit_log (
    operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note
  ) VALUES (
    v_staff.operator_id, v_user, 'pickup.manager_override', p_invoice_id,
    jsonb_build_object('invoice_status', v_invoice.status),
    jsonb_build_object(
      'lot_ids', to_jsonb(v_picked),
      'requested_count', COALESCE(array_length(v_targets, 1), 0),
      'stamped_count', COALESCE(array_length(v_picked, 1), 0),
      'already_picked_count', v_already_ct,
      'remaining_count', v_remaining_ct,
      'pickup_completed', v_completed,
      'reason', p_reason
    ),
    COALESCE(NULLIF(btrim(p_note), ''), 'Manager pickup override: ' || p_reason)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'picked_count', COALESCE(array_length(v_picked, 1), 0),
    'already_count', v_already_ct,
    'remaining_count', v_remaining_ct,
    'pickup_completed', v_completed
  );
END;
$$;

REVOKE ALL ON FUNCTION manager_pickup_override(UUID, UUID[], TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION manager_pickup_override(UUID, UUID[], TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION manager_pickup_override(UUID, UUID[], TEXT, TEXT) IS
  '0256: manager/admin-only manual pickup override. Stamps '
  'invoice_lots.picked_up_at for the given lots (or all owed), flips staged '
  'bin_assignments, completes the pickups row when nothing is owed (0217/0245 '
  'semantics), and always audits to operator_audit_log with the required '
  'reason. Prevents no-show/forfeit/relot of items already released.';

COMMIT;
