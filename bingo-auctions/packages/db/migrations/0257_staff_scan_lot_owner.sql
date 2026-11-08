-- migration 0257 — staff_scan_lot_owner: "whose item is this?" for checkout
--
-- Staff feedback 2026-07-10 (large pickups): scanning an item that isn't on
-- the current customer's invoice only said "Not on this order" — no clue WHO
-- actually won it, so redirecting a misplaced box meant opening multiple
-- screens while a 50-item line waited.
--
-- staff_scan_lot_owner(p_candidates):
--   • Resolves the scan to a lot via the shared _find_lot_by_scan ladder
--     (qr_token → lot_code → sticker_code → lpn → fnsku → asin →
--     external_code), same as intake/put-away.
--   • Returns the lot's OWNERSHIP context: winning bidder (display name +
--     permanent bidder_number), auction title, invoice id/status, per-item
--     pickup state (awaiting / picked up / refunded + timestamps), and the
--     pickup row's status.
--   • Operator-scoped: staff only see lots owned by their operator. Exposes
--     the bidder's name — operator staff already see full bidder contact on
--     every invoice/pickup screen, so no new exposure class.
--
-- Returns:
--   { ok:false, reason:'not_authenticated'|'not_operator_staff'|'lot_not_found' }
--   { ok:true, lot:{...}, owner:null }                      — never invoiced
--   { ok:true, lot:{...}, owner:{...} }                     — invoiced

BEGIN;

CREATE OR REPLACE FUNCTION public.staff_scan_lot_owner(p_candidates TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op      UUID := public.current_operator_id();
  v_found   JSONB;
  v_lot_id  UUID;
  v_lot_op  UUID;
  v_owner   JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  IF v_op IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  v_found := public._find_lot_by_scan(p_candidates);
  IF COALESCE((v_found->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;

  v_lot_id := (v_found->'lot'->>'id')::UUID;
  v_lot_op := (v_found->'lot'->>'operator_id')::UUID;
  IF v_lot_op IS DISTINCT FROM v_op THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;

  -- Latest invoice this lot appears on (a relisted lot can have several).
  SELECT jsonb_build_object(
    'invoice_id', i.id,
    'invoice_status', i.status,
    'invoice_created_at', i.created_at,
    'bidder_name', COALESCE(b.display_name, b.email),
    'bidder_number', b.bidder_number,
    'auction_title', a.title,
    'picked_up_at', il.picked_up_at,
    'refunded_at', il.refunded_at,
    'pickup_status', p.status,
    'pickup_completed_at', p.completed_at
  )
  INTO v_owner
  FROM invoice_lots il
  JOIN invoices i ON i.id = il.invoice_id
  JOIN bidders b ON b.id = i.bidder_id
  LEFT JOIN auctions a ON a.id = i.auction_id
  LEFT JOIN pickups p ON p.invoice_id = i.id
  WHERE il.lot_id = v_lot_id
    AND i.operator_id = v_op
  ORDER BY i.created_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'ok', true,
    'matched_field', v_found->>'matched_field',
    'lot', jsonb_build_object(
      'id', v_lot_id,
      'lot_code', v_found->'lot'->>'lot_code',
      'sticker_code', v_found->'lot'->>'sticker_code',
      'title', v_found->'lot'->>'title',
      'status', v_found->'lot'->>'status'
    ),
    'owner', v_owner
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_scan_lot_owner(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_scan_lot_owner(TEXT[]) TO authenticated;

COMMENT ON FUNCTION public.staff_scan_lot_owner(TEXT[]) IS
  '0257: checkout "whose item is this?" — resolves a scan to a lot '
  '(_find_lot_by_scan ladder) and returns winning bidder + auction + invoice '
  '+ per-item pickup state so staff can redirect misplaced boxes instantly.';

COMMIT;
