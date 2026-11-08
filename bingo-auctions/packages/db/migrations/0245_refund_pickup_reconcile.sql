-- 0245 — refunds and pickups finally agree (Jared test recap 2026-07-07)
--
-- Two field findings, one root cause: a refund changes invoices.status but
-- nothing per-lot or per-pickup, so every surface that derives "what does
-- this customer still pick up" disagrees with the money truth.
--
--   1. Customer Pickup Pass kept showing refunded items (loadSessionContents
--      had no invoice-status or per-lot-refund filter).
--   2. A pickup whose invoice was fully refunded stayed pending/scheduled
--      forever: "Mark complete" is disabled on refunded invoices (money-loss
--      guard), leaving only the destructive No-show / Forfeit buttons —
--      which would relist refunded goods.
--   3. staff_scan_bidder_token only returned status='paid' invoices, so a
--      PARTIAL refund made the customer's remaining (still-owed!) items
--      unscannable at the counter.
--
-- Fixes here:
--   • invoice_lots.refunded_at — per-lot refund stamp, written by the
--     refund-items API from now on; backfilled from operator_audit_log
--     (invoice.refund_item rows carry lot_id + created_at) and, for fully
--     refunded invoices, blanket-stamped.
--   • Stranded pickups on fully-refunded invoices auto-complete (one-time
--     backfill; the refund-items API keeps this invariant going forward).
--   • staff_scan_bidder_token v5: includes partially_refunded invoices and
--     exposes a per-lot 'refunded' flag so the Staff app can hide those
--     line items.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; backfills guarded by IS NULL;
-- CREATE OR REPLACE FUNCTION.

BEGIN;

-- ── 1. Per-lot refund stamp ──────────────────────────────────────────────
ALTER TABLE invoice_lots ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

-- Staff attribution (Jared recap: individual logins so actions can be
-- audited by employee): record WHICH staff login confirmed each handover.
-- Stamped by staff_confirm_pickup below; NULL on pre-0245 rows.
ALTER TABLE invoice_lots ADD COLUMN IF NOT EXISTS picked_up_by uuid REFERENCES auth.users(id);
ALTER TABLE pickups      ADD COLUMN IF NOT EXISTS completed_by uuid REFERENCES auth.users(id);

COMMENT ON COLUMN invoice_lots.picked_up_by IS
  '0245: auth.users id of the staff member who confirmed this lot''s '
  'handover (staff_confirm_pickup). NULL = pre-0245 or web-dashboard path.';
COMMENT ON COLUMN pickups.completed_by IS
  '0245: auth.users id of the staff member whose confirmation completed '
  'this pickup. NULL = pre-0245, auto-completed by a refund, or web path.';

COMMENT ON COLUMN invoice_lots.refunded_at IS
  '0245: when this line item was refunded (per-item Square refund via '
  '/api/invoices/[id]/refund-items). NULL = not refunded. A refunded lot '
  'is no longer owed to the bidder: it drops off the Pickup Pass and the '
  'staff checkout list, and is excluded from no-show/forfeit relisting.';

-- Backfill A: per-item refunds recorded in the audit log (the refund-items
-- route has written one row per item since the Square rebuild).
UPDATE invoice_lots il
SET refunded_at = sub.refunded_at
FROM (
  SELECT
    oal.target_id                          AS invoice_id,
    (oal.after_state ->> 'lot_id')::uuid   AS lot_id,
    min(oal.created_at)                    AS refunded_at
  FROM operator_audit_log oal
  WHERE oal.action_type = 'invoice.refund_item'
    AND oal.after_state ? 'lot_id'
  GROUP BY 1, 2
) sub
WHERE il.invoice_id = sub.invoice_id
  AND il.lot_id     = sub.lot_id
  AND il.refunded_at IS NULL;

-- Backfill B: fully refunded invoices — every line item is refunded even if
-- the refund predates the audit log or went through Square directly.
UPDATE invoice_lots il
SET refunded_at = now()
FROM invoices i
WHERE i.id = il.invoice_id
  AND i.status = 'refunded'
  AND il.refunded_at IS NULL;

-- ── 2. Close out pickups stranded by a full refund ───────────────────────
-- Nothing is owed on a fully refunded invoice; the pickup is done. Without
-- this they sit on the dashboard offering only No-show/Forfeit (which would
-- wrongly route the refunded lots back to 'unsold' for relisting).
UPDATE pickups p
SET status = 'completed', completed_at = COALESCE(p.completed_at, now())
FROM invoices i
WHERE i.id = p.invoice_id
  AND i.status = 'refunded'
  AND p.status IN ('pending', 'scheduled', 'checked_in');

-- ── 3. staff_scan_bidder_token v5 ────────────────────────────────────────
-- Changes vs 0244: invoice filter widened to partially_refunded (remaining
-- items stay scannable after a partial refund) and a per-lot 'refunded'
-- flag. Body otherwise identical to 0244 (session-token fallback intact).
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
  IF v_operator IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  -- ── Resolve token → bidder. Per-invoice pickup token first (original
  --    QR), then a pickup-pass session token (0241/0244). ────────────────
  SELECT i.bidder_id, i.operator_id
    INTO v_bidder, v_scanned_op
  FROM pickups p
  JOIN invoices i ON i.id = p.invoice_id
  WHERE p.bidder_check_in_token = p_token
  LIMIT 1;

  IF v_bidder IS NULL THEN
    SELECT ps.bidder_id, v_operator
      INTO v_bidder, v_scanned_op
    FROM pickup_sessions ps
    WHERE ps.token = p_token
    LIMIT 1;
  END IF;

  IF v_bidder IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'token_not_found');
  END IF;

  IF v_scanned_op <> v_operator THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'other_operator');
  END IF;

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
          'invoice_status',      i.status,
          'invoice_total_cents', i.total_cents,
          'lots', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                     'lot_id',    l.id,
                     'lot_code',  l.lot_code,
                     'title',     l.title,
                     'bin_code',  asg.bin_code,
                     'staged',    (asg.status = 'staged'),
                     'picked_up', (asg.status = 'picked_up' OR il.picked_up_at IS NOT NULL),
                     'refunded',  (il.refunded_at IS NOT NULL)
                   ) ORDER BY l.lot_code)
            FROM invoice_lots il
            JOIN lots l ON l.id = il.lot_id
            LEFT JOIN LATERAL (
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
        -- 0245: partially_refunded invoices still owe the un-refunded lots.
        AND i.status IN ('paid', 'partially_refunded')
        AND p.status IN ('pending', 'scheduled', 'checked_in')
    ) j
  ) pk ON true
  WHERE b.id = v_bidder;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION staff_scan_bidder_token(UUID) TO authenticated;

COMMENT ON FUNCTION staff_scan_bidder_token(UUID) IS
  '0245: partially_refunded invoices stay scannable (remaining lots are '
  'still owed); per-lot refunded flag lets the Staff app hide refunded '
  'line items. Session-token fallback from 0244 intact.';

-- ── 4. staff_confirm_pickup v3 (0217 body + refund awareness + who) ──────
-- Changes vs 0217:
--   • invoice guard widened: partially_refunded invoices are collectable
--     (their un-refunded lots are still owed; 0217 raised invoice_not_paid).
--   • refunded lots are excluded from the "missing" check and from the
--     remaining-owed count — the pickup completes once every lot is either
--     handed over or refunded.
--   • stamps invoice_lots.picked_up_by / pickups.completed_by = auth.uid()
--     so handovers are attributable to the individual staff login.
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
  -- 0245: partially_refunded = paid invoice with some items refunded; the
  -- rest are still owed and must remain collectable at the counter.
  IF v_invoice.status NOT IN ('paid', 'partially_refunded') THEN
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
  -- 0245: refunded lots are not owed — never count them as missing.
  SELECT COALESCE(array_agg(l.lot_code ORDER BY l.lot_code), ARRAY[]::TEXT[])
    INTO v_missing
  FROM invoice_lots il
  JOIN lots l ON l.id = il.lot_id
  WHERE il.invoice_id = p_invoice_id
    AND il.picked_up_at IS NULL
    AND il.refunded_at IS NULL
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
    -- 0245: also record WHO confirmed the handover.
    UPDATE invoice_lots
       SET picked_up_at = now(),
           picked_up_by = v_user
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
  -- 0245: refunded lots are resolved, not owed.
  SELECT count(*) INTO v_remaining_ct
  FROM invoice_lots
  WHERE invoice_id = p_invoice_id
    AND picked_up_at IS NULL
    AND refunded_at IS NULL;

  IF v_remaining_ct = 0 THEN
    UPDATE pickups
       SET checked_in_at = COALESCE(checked_in_at, now()),
           completed_at  = now(),
           completed_by  = v_user,
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
  '0245: 0217 behavior + partially_refunded invoices stay collectable, '
  'refunded lots count as resolved (never missing/owed), and handovers are '
  'attributed to the confirming staff login via invoice_lots.picked_up_by / '
  'pickups.completed_by.';

COMMIT;
