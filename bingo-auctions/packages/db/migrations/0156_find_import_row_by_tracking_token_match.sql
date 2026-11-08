-- 0156 — find_import_row_by_tracking: token-aware lookup
--
-- WHY: the Wayfair returns manifest had dirty ReturnTrackingNumber cells where
-- 2-4 FedEx trackings were SPACE-separated (no comma) or had trailing notes
-- ("d/d", "donate dispose", "Return tracking number ...", "vERT-..."). The
-- importer's expandRowsByTracking only splits on COMMAS, so those rows landed
-- in import_rows.tracking_number as one combined string. When staff scan a real
-- 12-digit FedEx number off a box, the exact-match RPC misses every box whose
-- tracking is a token inside one of these combined strings.
--
-- Live evidence (queried 2026-05-28 prod): 150 of 15,750 tracking-bearing rows
-- have malformed values. Lengths 16-64 with embedded spaces; or short notes
-- like "d/d", "DD", "disposal" (those won't match a scan and are ignorable).
-- One 51-char row represents FOUR physical boxes
-- ("486572077526 486572077559 486572077537 486572077548"); under the previous
-- exact-match RPC only 1 of those 4 boxes (whose label happens to read the
-- whole string, which never happens) could ever resolve.
--
-- FIX: keep exact match as the indexed fast path; add a fallback that matches
-- the scanned code as a TOKEN in the stored string (bounded by space, comma,
-- or string start/end). LENGTH(v_clean) >= 12 prevents short garbage scans
-- ('d', 'DD') from matching too broadly. Token boundaries prevent prefix
-- collisions (scanning '11234' won't false-match '11234567').
--
-- ORDER BY (exact = true) DESC keeps exact matches preferred over token
-- matches if both exist on different rows.
--
-- Idempotent (CREATE OR REPLACE). Read-only. No data migration. No app code
-- change required — the field-mobile staff app calls this same RPC and gets
-- more hits automatically. In-review iOS builds #40/#49 unaffected; preview
-- TestFlight #53 unaffected.
--
-- Companion future fixes (not in this migration):
--   - importer: expandRowsByTracking should also split on whitespace and drop
--     non-12-digit tokens (prevent dirty rows next import).
--   - data cleanup: split the existing 150 dirty rows into one row per valid
--     12-digit token, preserving import_id provenance.

CREATE OR REPLACE FUNCTION public.find_import_row_by_tracking(p_tracking TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id  UUID;
  v_clean  TEXT := TRIM(p_tracking);
  v_row    import_rows%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;
  IF v_clean IS NULL OR LENGTH(v_clean) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_tracking');
  END IF;

  -- Primary path: exact match (indexed by import_rows_tracking_lookup).
  -- Fallback: token match for multi-tracking strings (space/comma separated).
  -- Length guard ensures short scans don't false-match across long fields.
  -- ORDER prefers exact match if both exist.
  SELECT * INTO v_row FROM import_rows
   WHERE operator_id = v_op_id
     AND status = 'pending'
     AND (
       tracking_number = v_clean
       OR (LENGTH(v_clean) >= 12 AND (
         tracking_number LIKE v_clean || ' %'
         OR tracking_number LIKE '% ' || v_clean
         OR tracking_number LIKE '% ' || v_clean || ' %'
         OR tracking_number LIKE v_clean || ',%'
         OR tracking_number LIKE '%,' || v_clean
         OR tracking_number LIKE '%,' || v_clean || ',%'
       ))
     )
   ORDER BY (tracking_number = v_clean) DESC, created_at ASC
   LIMIT 1;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'manifest_row_not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row));
END;
$$;

REVOKE ALL ON FUNCTION public.find_import_row_by_tracking(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_import_row_by_tracking(TEXT) TO authenticated;

COMMENT ON FUNCTION public.find_import_row_by_tracking(TEXT) IS
  '0156 (Wayfair, token-aware): operator-scoped lookup of a PENDING import_row '
  'by tracking_number. Exact match first (indexed), then token match for dirty '
  'multi-tracking strings (space- or comma-separated). Returns { ok, '
  'manifest_row } jsonb. Read-only; authenticated operator-staff only.';
