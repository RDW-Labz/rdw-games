-- 0244 — staff_scan_bidder_token v3: Pickup-pass session QRs scan in the
-- Staff app (Jared test finding #4, owner: "do it")
--
-- The web Pickup pass QR encodes /pickups/session/{token} and the Staff
-- app's extractToken() already pulls any UUID out of a scanned string —
-- but this RPC only matched pickups.bidder_check_in_token, so session QRs
-- died with "Token not found". Add a fallback: no pickup matches → try
-- pickup_sessions.token (mig 0241) → same bidder, same consolidated
-- multi-invoice payload. Zero app changes needed.
--
-- Cross-tenant note: pickup_sessions has no operator_id (single-operator
-- platform); the payload below is already scoped to the CALLER's operator,
-- so a foreign bidder simply yields an empty pickups list.
--
-- Body otherwise identical to 0217's version (checked_in visible,
-- per-lot picked_up from invoice_lots stamp). Idempotent.

BEGIN;

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
          'invoice_total_cents', i.total_cents,
          'lots', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                     'lot_id',    l.id,
                     'lot_code',  l.lot_code,
                     'title',     l.title,
                     'bin_code',  asg.bin_code,
                     'staged',    (asg.status = 'staged'),
                     'picked_up', (asg.status = 'picked_up' OR il.picked_up_at IS NOT NULL)
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
        AND i.status      = 'paid'
        AND p.status IN ('pending', 'scheduled', 'checked_in')
    ) j
  ) pk ON true
  WHERE b.id = v_bidder;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION staff_scan_bidder_token(UUID) TO authenticated;

COMMENT ON FUNCTION staff_scan_bidder_token(UUID) IS
  '0244: also resolves pickup_sessions.token (web Pickup-pass QR) — one QR '
  'works in both the Staff app scanner and the web counter page.';

COMMIT;
