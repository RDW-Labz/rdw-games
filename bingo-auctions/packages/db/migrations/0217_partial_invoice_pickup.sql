-- 0217 — partial invoice pickup (tester feature request 2026-07-03)
--
-- BEFORE: staff_confirm_pickup (0079 → 0147) had per-lot *verification* and
-- even a "hand over N, the rest stays owed" confirm dialog in pickup-verify —
-- but the function then unconditionally closed the pickups row
-- (status='completed', completed_at=now()) and fired pickup_confirmed. A
-- partial handover therefore completed the WHOLE invoice: the remaining lots
-- had no live pickup, the bidder's QR died, and "can be picked up later" was
-- a lie. One oversized item blocked (or force-closed) the entire checkout.
--
-- AFTER:
--   * invoice_lots.picked_up_at TIMESTAMPTZ — per-lot handover truth. Stamped
--     for every lot code the staffer confirms, INDEPENDENT of bin_assignments
--     (manual-checkout / never-staged lots get stamped too; the
--     bin_assignments flip remains for staging-board state).
--   * staff_confirm_pickup completes the pickups row ONLY when every
--     invoice_lot is stamped. A partial round leaves the pickup open at
--     status='checked_in' (checked_in_at set) so the bidder QR keeps
--     resolving and the no-show sweep (0183: only 'pending'/'scheduled')
--     never touches it. pickup_confirmed fires only on FULL completion, so
--     the refund window (operator_policies.refund_window_post_pickup_hours,
--     keyed off pickups.completed_at) is unchanged.
--   * Each partial round writes an operator_audit_log row
--     (action_type 'pickup.partial_handover': codes handed over + remaining
--     count) — SECURITY DEFINER inserts directly; the log has no client
--     INSERT policy by design (0157).
--   * "Missing" is now defined off invoice_lots.picked_up_at, so multi-round
--     pickups converge: round 2 only owes what round 1 didn't stamp.
--
-- Backfill: completed pickups stamp all their invoice_lots with
-- completed_at so historical invoices read as fully picked.
--
-- Signature and staff_confirm_pickup_result shape are UNCHANGED (0147's
-- p_allow_incomplete stays the explicit partial opt-in; the client dialog
-- already drives it).

BEGIN;

-- 'checked_in' joins the pickup_status enum (0001 shipped without it even
-- though pickups.checked_in_at exists). PG12+ allows ADD VALUE inside a
-- transaction as long as the new value isn't USED in the same transaction —
-- and it isn't: the function bodies below only reference it at runtime, and
-- the backfill doesn't touch it. Clients compare against specific values
-- ('completed' / 'no_show'), so an unrecognized status falls through to
-- "active pickup" rendering, which is exactly right for a partial.
ALTER TYPE pickup_status ADD VALUE IF NOT EXISTS 'checked_in';

ALTER TABLE public.invoice_lots
  ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMPTZ;

COMMENT ON COLUMN public.invoice_lots.picked_up_at IS
  '0217: when THIS lot physically left with the bidder (staff_confirm_pickup '
  'stamp). NULL = still owed. The pickups row completes only when every lot '
  'on the invoice is stamped.';

CREATE OR REPLACE FUNCTION staff_confirm_pickup(
  p_invoice_id        UUID,
  p_lot_codes         TEXT[],
  p_allow_incomplete  BOOLEAN DEFAULT FALSE
)
RETURNS staff_confirm_pickup_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user           UUID := auth.uid();
  v_operator       UUID;
  v_invoice        invoices%ROWTYPE;
  v_pickup         pickups%ROWTYPE;
  v_lot_id         UUID;
  v_lot_code       TEXT;
  v_already_picked INT := 0;
  v_not_found_ct   INT := 0;
  v_picked_ct      INT := 0;
  v_missing        TEXT[];
  v_remaining_ct   INT := 0;
  v_warning        TEXT := NULL;
  v_result         staff_confirm_pickup_result;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT operator_id INTO v_operator
    FROM operator_users WHERE user_id = v_user LIMIT 1;
  IF v_operator IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff';
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found';
  END IF;
  IF v_invoice.operator_id <> v_operator THEN
    RAISE EXCEPTION 'invoice_other_operator';
  END IF;
  IF v_invoice.status <> 'paid' THEN
    RAISE EXCEPTION 'invoice_not_paid';
  END IF;

  SELECT * INTO v_pickup FROM pickups WHERE invoice_id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pickup_not_found';
  END IF;

  -- Idempotency (unchanged from 0147).
  IF v_pickup.status = 'completed' THEN
    v_result := (
      v_pickup.id,
      (SELECT count(*) FROM bin_assignments ba
       JOIN invoice_lots il ON il.lot_id = ba.lot_id
       WHERE il.invoice_id = p_invoice_id AND ba.status = 'picked_up'),
      'already_completed',
      ARRAY[]::TEXT[]
    );
    RETURN v_result;
  END IF;

  -- ── Missing = invoice lots not stamped yet and not in this round ──────
  -- 0217: keyed off invoice_lots.picked_up_at (round-stable) instead of
  -- bin_assignments (which never covers never-staged manual-checkout lots).
  SELECT COALESCE(array_agg(l.lot_code ORDER BY l.lot_code), ARRAY[]::TEXT[])
    INTO v_missing
  FROM invoice_lots il
  JOIN lots l ON l.id = il.lot_id
  WHERE il.invoice_id = p_invoice_id
    AND il.picked_up_at IS NULL
    AND NOT (l.lot_code = ANY(p_lot_codes));

  IF array_length(v_missing, 1) > 0 AND NOT COALESCE(p_allow_incomplete, FALSE) THEN
    -- Money-loss guard (0147): refuse until the caller explicitly opts into
    -- a partial handover. DETAIL carries the missing codes for the client
    -- confirm dialog.
    RAISE EXCEPTION 'pickup_incomplete: %', array_to_string(v_missing, ',')
      USING DETAIL = array_to_string(v_missing, ',');
  END IF;

  -- ── Per-lot flip ──────────────────────────────────────────────────────
  FOREACH v_lot_code IN ARRAY p_lot_codes
  LOOP
    SELECT l.id INTO v_lot_id
    FROM lots l
    JOIN invoice_lots il ON il.lot_id = l.id
    WHERE il.invoice_id = p_invoice_id
      AND l.lot_code = v_lot_code
    LIMIT 1;

    IF NOT FOUND THEN
      v_not_found_ct := v_not_found_ct + 1;
      CONTINUE;
    END IF;

    -- 0217: the authoritative per-lot handover stamp (idempotent).
    UPDATE invoice_lots
       SET picked_up_at = now()
     WHERE invoice_id = p_invoice_id
       AND lot_id = v_lot_id
       AND picked_up_at IS NULL;

    IF FOUND THEN
      v_picked_ct := v_picked_ct + 1;
    ELSE
      v_already_picked := v_already_picked + 1;
    END IF;

    -- Staging-board state (unchanged from 0147): flip the latest STAGED
    -- assignment; never-staged lots simply have no row to flip.
    WITH latest AS (
      SELECT ba.id
      FROM bin_assignments ba
      WHERE ba.lot_id = v_lot_id
      ORDER BY ba.assigned_at DESC
      LIMIT 1
    )
    UPDATE bin_assignments ba
       SET status = 'picked_up', picked_up_at = now()
      FROM latest
     WHERE ba.id = latest.id
       AND ba.status = 'staged';
  END LOOP;

  -- ── Complete or keep open ─────────────────────────────────────────────
  SELECT count(*) INTO v_remaining_ct
  FROM invoice_lots
  WHERE invoice_id = p_invoice_id
    AND picked_up_at IS NULL;

  IF v_remaining_ct = 0 THEN
    UPDATE pickups
       SET checked_in_at = COALESCE(checked_in_at, now()),
           completed_at  = now(),
           status        = 'completed',
           updated_at    = now()
     WHERE id = v_pickup.id;

    -- Notification only on FULL completion — a partial handover happened
    -- face-to-face; pinging "pickup confirmed" while lots are still owed
    -- misled bidders (and my-bids keys off the completed pickup).
    PERFORM enqueue_notification(
      'pickup_confirmed',
      v_invoice.bidder_id,
      jsonb_build_object(
        'invoice_id', p_invoice_id,
        'lots_picked', v_picked_ct,
        'lots_missing', 0
      ),
      'pickup_confirmed:staff:' || p_invoice_id::TEXT
    );
  ELSE
    -- 0217: partial handover — keep the pickup ALIVE so the QR keeps
    -- resolving and the remaining lots stay owed. checked_in marks "the
    -- bidder has been here"; the 0183 no-show sweep only touches
    -- 'pending'/'scheduled' so an open partial is never forfeited.
    UPDATE pickups
       SET checked_in_at = COALESCE(checked_in_at, now()),
           status        = 'checked_in',
           updated_at    = now()
     WHERE id = v_pickup.id;

    -- Audit each partial round (definer insert; log has no client policy).
    INSERT INTO operator_audit_log (
      operator_id, actor_user_id, action_type, target_id, before_state, after_state
    ) VALUES (
      v_operator, v_user, 'pickup.partial_handover', p_invoice_id, NULL,
      jsonb_build_object(
        'handed_over_codes', to_jsonb(p_lot_codes),
        'handed_over_count', v_picked_ct,
        'remaining_count', v_remaining_ct
      )
    );

    v_warning := format('partial: %s lot(s) still owed — invoice stays open', v_remaining_ct);
  END IF;

  IF v_not_found_ct > 0 OR v_already_picked > 0 THEN
    v_warning := COALESCE(v_warning || '; ', '') || format(
      '%s lot(s) not in invoice; %s already picked up',
      v_not_found_ct, v_already_picked
    );
  END IF;

  v_result := (v_pickup.id, v_picked_ct, v_warning, COALESCE(v_missing, ARRAY[]::TEXT[]));
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION staff_confirm_pickup(UUID, TEXT[], BOOLEAN) TO authenticated;

COMMENT ON FUNCTION staff_confirm_pickup(UUID, TEXT[], BOOLEAN) IS
  '0217: per-lot pickup. Stamps invoice_lots.picked_up_at for each confirmed '
  'code; completes the pickups row ONLY when every invoice lot is stamped. '
  'Partial rounds (p_allow_incomplete=TRUE) keep the pickup open at '
  'checked_in, audit to operator_audit_log, and fire NO notification. '
  'pickup_confirmed + completed_at (the refund-window anchor) remain '
  'full-completion-only. See 0079/0147 for lineage.';

-- ===========================================================================
-- staff_scan_bidder_token — partial pickups must stay scannable
--
-- 0206 scoped the "active pickups" list to status IN ('pending','scheduled').
-- A 0217 partial leaves the pickup at 'checked_in', which would make the
-- bidder's QR come back empty on the return trip — the exact failure this
-- migration exists to prevent. Widened to include 'checked_in', and each
-- lot's picked_up flag now also reads the invoice_lots stamp so staff see at
-- a glance which items already left.
-- ===========================================================================
CREATE OR REPLACE FUNCTION staff_scan_bidder_token(p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operator   UUID := current_operator_id();
  v_bidder     UUID;
  v_scanned_op UUID;
  v_result     JSONB;
BEGIN
  -- ── Auth: caller must be operator staff ──────────────────────────────────
  IF v_operator IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  -- ── Resolve token → pickup → invoice's bidder + owning operator ──────────
  -- No status filter here: an old/completed token still identifies the bidder;
  -- we surface whatever is still ACTIVE below.
  SELECT i.bidder_id, i.operator_id
    INTO v_bidder, v_scanned_op
  FROM pickups p
  JOIN invoices i ON i.id = p.invoice_id
  WHERE p.bidder_check_in_token = p_token
  LIMIT 1;

  IF v_bidder IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'token_not_found');
  END IF;

  -- ── Cross-tenant guard ───────────────────────────────────────────────────
  IF v_scanned_op <> v_operator THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'other_operator');
  END IF;

  -- ── Build consolidated payload ───────────────────────────────────────────
  SELECT jsonb_build_object(
    'ok', true,
    'bidder', jsonb_build_object(
      'id',    b.id,
      'name',  b.display_name,
      'email', b.email
    ),
    'pickups',        COALESCE(pk.arr, '[]'::jsonb),
    'total_invoices', COALESCE(pk.n_invoices, 0),
    'total_lots',     COALESCE(pk.n_lots, 0)
  )
  INTO v_result
  FROM bidders b
  LEFT JOIN LATERAL (
    SELECT
      jsonb_agg(j.obj ORDER BY j.created_at) AS arr,
      count(*)                               AS n_invoices,
      COALESCE(sum(j.lot_count), 0)          AS n_lots
    FROM (
      SELECT
        i.created_at,
        (SELECT count(*) FROM invoice_lots il WHERE il.invoice_id = i.id) AS lot_count,
        jsonb_build_object(
          'invoice_id',          i.id,
          'pickup_id',           p.id,
          'token',               p.bidder_check_in_token,
          'status',              p.status,
          'invoice_total_cents', i.total_cents,
          'lots', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                     'lot_id',    l.id,
                     'lot_code',  l.lot_code,
                     'title',     l.title,
                     'bin_code',  asg.bin_code,
                     'staged',    (asg.status = 'staged'),
                     -- 0217: the invoice_lots stamp wins — covers never-staged
                     -- manual-checkout lots handed over in a prior round.
                     'picked_up', (asg.status = 'picked_up' OR il.picked_up_at IS NOT NULL)
                   ) ORDER BY l.lot_code)
            FROM invoice_lots il
            JOIN lots l ON l.id = il.lot_id
            LEFT JOIN LATERAL (
              -- latest assignment for this lot + its bin code
              SELECT bn.code AS bin_code, a2.status
              FROM bin_assignments a2
              LEFT JOIN bins bn ON bn.id = a2.bin_id
              WHERE a2.lot_id = l.id
              ORDER BY a2.assigned_at DESC NULLS LAST
              LIMIT 1
            ) asg ON true
            WHERE il.invoice_id = i.id
          ), '[]'::jsonb)
        ) AS obj
      FROM pickups p
      JOIN invoices i ON i.id = p.invoice_id
      WHERE i.bidder_id   = b.id
        AND i.operator_id = v_operator
        AND i.status      = 'paid'
        -- 0217: 'checked_in' = a partial pickup in flight — must stay visible.
        AND p.status IN ('pending', 'scheduled', 'checked_in')
    ) j
  ) pk ON true
  WHERE b.id = v_bidder;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION staff_scan_bidder_token(UUID) TO authenticated;

COMMENT ON FUNCTION staff_scan_bidder_token(UUID) IS
  '0217: bidder-token scan for combined checkout. Active set now includes '
  'checked_in (partial pickups in flight); per-lot picked_up reads the '
  'invoice_lots.picked_up_at stamp as well as the bin flip. See 0206.';

-- ── Backfill: historical completed pickups are fully picked ──────────────
UPDATE invoice_lots il
   SET picked_up_at = p.completed_at
  FROM pickups p
 WHERE p.invoice_id = il.invoice_id
   AND p.status = 'completed'
   AND p.completed_at IS NOT NULL
   AND il.picked_up_at IS NULL;

COMMIT;
