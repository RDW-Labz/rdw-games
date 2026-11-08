-- ============================================================================
-- Migration 0206 — staff_scan_bidder_token: consolidated pickup lookup by token
--
-- WHY (June-14 tester recap, items #2 + #3):
--   #2 "Bidder (no name on file)" — pickup-verify joins invoices ->
--      bidders(display_name,email), but public.bidders has only the
--      `bidders_self_read` RLS policy (USING id = auth.uid()). A staff session
--      is not the bidder, so the embed returns NULL and the counter shows no
--      name. We must NOT add a blanket staff-read policy on bidders (that table
--      holds email, phone, stripe_customer_id, default_payment_method_id —
--      cross-row PII). Instead expose a COLUMN-SAFE read via this SECURITY
--      DEFINER RPC: it returns ONLY display_name + email, and only for a bidder
--      the caller's operator actually has a pickup with.
--   #3 Receipt consolidation — pickups are 1-per-invoice (mig 0001), so a
--      bidder with N won invoices has N tokens / N QRs and staff repeat
--      checkout N times. This RPC resolves ONE scanned token to the bidder and
--      returns ALL of that bidder's ACTIVE pickups at the caller's operator in
--      a single call, so the staff app can present one combined checkout.
--
-- AUTH MODEL (mirrors staff_confirm_pickup, mig 0079):
--   * caller must be operator staff — current_operator_id() (mig 0002) returns
--     their operator_id; NULL => not staff/anon => 'not_operator_staff'.
--   * cross-tenant guard — the scanned token's pickup must belong to the
--     caller's operator, else 'other_operator'. Same guard shape as 0079's
--     invoice.operator_id check; prevents one operator reading another's
--     bidder identity or pickups.
--
-- RETURN (jsonb, easiest for the RN client):
--   error:   { ok:false, reason:'not_operator_staff'|'token_not_found'|'other_operator' }
--   success: { ok:true,
--              bidder:{ id, name, email },               -- column-safe ONLY
--              pickups:[ { invoice_id, pickup_id, token, status,
--                          invoice_total_cents,
--                          lots:[ { lot_id, lot_code, title, bin_code,
--                                   staged, picked_up } ] } ],
--              total_invoices, total_lots }
--   "active" = invoice.status='paid' AND pickup.status IN ('pending','scheduled').
--   Completed/no_show/forfeited pickups are excluded (nothing left to hand over).
--   An empty pickups array with ok:true means the bidder has no outstanding
--   pickups at this operator (e.g. a stale/old QR was scanned).
--
-- INERT until wired: nothing calls this yet. Phase C (field-mobile
-- pickup-verify rework) and the staff checkout UI consume it. Adding the
-- function changes no existing behavior. Real money is LIVE on the pickup
-- flow — this is a READ-ONLY lookup (no writes); the write/confirm path stays
-- staff_confirm_pickup, called per-invoice by the combined UI.
--
-- Refs: 0001 (pickups/invoices/bidders), 0002 (current_operator_id), 0079
--       (staff_confirm_pickup auth+cross-tenant pattern), bidders RLS gap.
-- ============================================================================

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
  -- bidder identity is COLUMN-SAFE (id, display_name, email only) and the
  -- pickups list is scoped to active pickups at the caller's operator.
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
                     'picked_up', (asg.status = 'picked_up')
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
        AND p.status IN ('pending', 'scheduled')
    ) j
  ) pk ON true
  WHERE b.id = v_bidder;

  RETURN v_result;
END;
$$;

-- Staff guard is inside the body; restrict EXECUTE to authenticated sessions.
GRANT EXECUTE ON FUNCTION staff_scan_bidder_token(UUID) TO authenticated;
