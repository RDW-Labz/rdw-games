-- ============================================================================
-- Migration 0153 — Wayfair per-box FedEx-tracking lotting (Option B)
--
-- See docs/state/PATCH-wayfair-tracking-lotting-2026-05-27.md.
--
-- TWO codes, not one — this migration only touches the FIRST:
--   • FedEx tracking = the manifest LOOKUP key at lotting. Scan the box's FedEx
--     return label → find the matching import_row → pre-fill the lot form.
--     Stored on import_rows.tracking_number. It is NOT the lot's identity.
--   • Pre-printed QR sticker = the lot's scannable identity, bound at lotting
--     via the already-shipped PreStickeredScanner unify (#97) →
--     lots.sticker_code / qr_token. Put-away + bidder scan resolution already
--     exist (intake_lot_to_bin 0142 + resolve_lot_by_sticker 0150) and are
--     UNTOUCHED here.
--
-- ADDITIVE ONLY:
--   1. import_rows.tracking_number TEXT + unique (non-partial) + partial lookup.
--   2. find_import_row_by_tracking(p_tracking) — operator-scoped lookup of a
--      PENDING import_row by tracking_number; returns the manifest-row jsonb so
--      quick-lot can seed the draft (mirrors lot_from_manifest's contract, 0142).
--   3. mark_import_row_lotted(p_import_row_id, p_lot_id) — flip a pending row to
--      'lotted' + link the freshly-created lot (provenance + re-lot guard). The
--      lot itself is still minted by create_draft_lot (0047); this only records
--      the manifest → lot association that createDraftLotFromCandidate omits.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. import_rows.tracking_number + indexes
-- ---------------------------------------------------------------------------
-- Each physical box arrives with its own FedEx return label. The importer
-- (Wayfair manifest) splits a row's comma-separated ReturnTrackingNumber into
-- one import_row per tracking, so each box becomes an individually-scannable,
-- lottable unit. Rows with no tracking keep tracking_number NULL.
ALTER TABLE public.import_rows
  ADD COLUMN IF NOT EXISTS tracking_number TEXT;

COMMENT ON COLUMN public.import_rows.tracking_number IS
  '0153 (Wayfair): the box''s carrier return-tracking number (e.g. FedEx). '
  'Manifest LOOKUP key at lotting only — scanned to pre-fill the lot form; NOT '
  'the lot''s identity (that is sticker_code / qr_token). One import_row per '
  'tracking after the importer expands comma-separated values. NULL = no '
  'tracking (row still lottable by other identifiers).';

-- Re-import safety: the same operator can't land the same tracking twice.
-- NON-partial (no WHERE) so the importer's
--   upsert(..., { onConflict: 'operator_id,tracking_number' })
-- can INFER this index for ON CONFLICT DO NOTHING — a partial index can't be
-- inferred unless the client supplies its predicate, which supabase-js/PostgREST
-- can't. NULLs are distinct in a multi-column unique index, so the unbounded
-- NULL-tracking rows of non-Wayfair manifests are still allowed (unconstrained),
-- exactly as a partial index would have left them. DROP first because the
-- partial form may already exist in prod from an earlier apply of this file.
DROP INDEX IF EXISTS public.import_rows_tracking_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS import_rows_tracking_uniq
  ON public.import_rows (operator_id, tracking_number);

-- Lotting lookup: "find the pending box for this scanned tracking".
CREATE INDEX IF NOT EXISTS import_rows_tracking_lookup
  ON public.import_rows (tracking_number)
  WHERE tracking_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. find_import_row_by_tracking(p_tracking TEXT)
-- ---------------------------------------------------------------------------
-- Quick-lot (field-mobile) scans the box's FedEx label and calls this to pull
-- up the matching PENDING manifest row so the lot form pre-fills with the
-- Wayfair title / photo / MSRP / return reason. Operator-scoped via
-- current_operator_id() (SECURITY DEFINER, same pattern as lot_from_manifest
-- 0142). Read-only — does NOT mint or modify any row (the client mints via
-- create_draft_lot then records the link via mark_import_row_lotted).
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

  SELECT * INTO v_row FROM import_rows
   WHERE operator_id = v_op_id
     AND status = 'pending'
     AND tracking_number = v_clean
   ORDER BY created_at ASC
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
  '0153 (Wayfair): operator-scoped lookup of a PENDING import_row by '
  'tracking_number. Returns { ok, manifest_row } jsonb so quick-lot can seed '
  'the draft. Read-only; authenticated operator-staff only.';

-- ---------------------------------------------------------------------------
-- 3. mark_import_row_lotted(p_import_row_id UUID, p_lot_id UUID)
-- ---------------------------------------------------------------------------
-- After quick-lot mints the lot (createDraftLotFromCandidate → create_draft_lot)
-- it calls this to flip the source manifest row pending → lotted and link the
-- new lot. Preserves Wayfair / FedEx provenance and stops the same box from
-- being lotted twice (find_import_row_by_tracking only returns status='pending').
-- Gated on operator membership (current_operator_id), not admin/manager: lotting
-- in quick-lot is already a staff-level action, and both the row and the lot are
-- scoped to the caller's operator.
CREATE OR REPLACE FUNCTION public.mark_import_row_lotted(
  p_import_row_id UUID,
  p_lot_id        UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id  UUID;
  v_count  INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  -- Defensive: the lot must belong to the caller's operator. Stops a staffer
  -- from linking another operator's lot id onto their manifest row.
  IF NOT EXISTS (
    SELECT 1 FROM lots WHERE id = p_lot_id AND operator_id = v_op_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;

  UPDATE import_rows
     SET status = 'lotted', lot_id = p_lot_id, lotted_at = now()
   WHERE id = p_import_row_id
     AND operator_id = v_op_id
     AND status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('ok', v_count > 0, 'updated', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_import_row_lotted(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_import_row_lotted(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.mark_import_row_lotted(UUID, UUID) IS
  '0153 (Wayfair): flip a PENDING import_row to lotted and link the lot just '
  'created from it (provenance + re-lot guard). Operator-scoped; authenticated '
  'operator-staff only.';

COMMIT;
