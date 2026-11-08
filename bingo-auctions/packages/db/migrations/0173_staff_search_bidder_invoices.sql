-- migration 0173 — staff customer-search fallback (S12)
--
-- Context: field staff cannot always scan a bidder's pickup QR (dark screen,
-- cracked glass, phone battery dead). This RPC powers a name/email/phone
-- search so staff can locate the right invoice and feed it into the same
-- staff_confirm_pickup verification flow without scanning.
--
-- Security model — mirrors assign_lot_to_bin / staff_confirm_pickup (mig 0147):
--   1. auth.uid() is resolved to operator_id via operator_users.
--   2. If not authenticated or not operator staff → return 0 rows (no RAISE,
--      so the client sees an empty list, not a leaked error shape).
--   3. invoices.operator_id = <caller's operator> — results are always
--      scoped to the single operator the staff member belongs to. A client-
--      passed operator id is NOT accepted as an input parameter.
--
-- Columns referenced:
--   bidders.display_name TEXT      ← mig 0001 line 37
--   bidders.email        TEXT      ← mig 0001 line 36
--   bidders.phone        TEXT      ← mig 0001 line 38  (exists; included)
--   invoices.operator_id UUID      ← mig 0001 line 281
--   invoices.bidder_id   UUID      ← mig 0001 line 283
--   invoices.status      invoice_status ← mig 0001 line 284
--   invoices.total_cents BIGINT    ← mig 0001 line 289
--   invoices.created_at  TIMESTAMPTZ ← mig 0001 line 297
--
-- Guard: p_query < 2 chars → 0 rows (avoids full-table ILIKE scans).
-- Scope: status = 'paid' only (staff are fulfilling pickup, not browsing all).
-- Limit: 25 results, ORDER BY created_at DESC.

BEGIN;

CREATE OR REPLACE FUNCTION staff_search_bidder_invoices(
  p_query TEXT
)
RETURNS TABLE (
  invoice_id   UUID,
  bidder_id    UUID,
  display_name TEXT,
  email        TEXT,
  status       TEXT,
  total_cents  BIGINT,
  created_at   TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user     UUID := auth.uid();
  v_operator UUID;
BEGIN
  -- ── 1. Auth guard ─────────────────────────────────────────────────────────
  IF v_user IS NULL THEN
    RETURN; -- 0 rows; caller is not authenticated
  END IF;

  -- ── 2. Operator-staff guard ────────────────────────────────────────────────
  -- Same pattern as assign_lot_to_bin and staff_confirm_pickup (mig 0147):
  --   SELECT operator_id INTO v_operator FROM operator_users WHERE user_id = v_user;
  SELECT operator_id INTO v_operator
    FROM operator_users
   WHERE user_id = v_user
   LIMIT 1;

  IF v_operator IS NULL THEN
    RETURN; -- caller is not staff for any operator
  END IF;

  -- ── 3. Empty / too-short query guard ──────────────────────────────────────
  IF p_query IS NULL OR length(trim(p_query)) < 2 THEN
    RETURN;
  END IF;

  -- ── 4. Search ─────────────────────────────────────────────────────────────
  -- Operator-scoped via v_operator (derived from auth.uid(), never trusted
  -- from the client). status = 'paid' only — staff fulfil pickups.
  RETURN QUERY
  SELECT
    i.id            AS invoice_id,
    i.bidder_id     AS bidder_id,
    b.display_name  AS display_name,
    b.email         AS email,
    i.status::TEXT  AS status,
    i.total_cents   AS total_cents,
    i.created_at    AS created_at
  FROM invoices i
  JOIN bidders b ON b.id = i.bidder_id
  WHERE i.operator_id = v_operator
    AND i.status = 'paid'
    AND (
         b.display_name ILIKE '%' || trim(p_query) || '%'
      OR b.email        ILIKE '%' || trim(p_query) || '%'
      OR b.phone        ILIKE '%' || trim(p_query) || '%'
    )
  ORDER BY i.created_at DESC
  LIMIT 25;
END;
$$;

-- Match the grant pattern from mig 0147 (assign_lot_to_bin, staff_confirm_pickup).
REVOKE ALL ON FUNCTION staff_search_bidder_invoices(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_search_bidder_invoices(TEXT) TO authenticated;

COMMENT ON FUNCTION staff_search_bidder_invoices(TEXT) IS
  'S12 (mig 0173): staff customer-search fallback for pickup verify. '
  'Resolves the caller''s operator from auth.uid() via operator_users — '
  'never trusts a client-passed operator id. Returns up to 25 paid invoices '
  'matching p_query against display_name / email / phone within the caller''s '
  'operator. Returns 0 rows (no error) for unauthenticated or non-staff '
  'callers, and for queries shorter than 2 characters.';

COMMIT;
