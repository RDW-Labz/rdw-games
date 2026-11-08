-- 0269 — atomic, idempotent manifest lotting (kills duplicate "Not Put Away" lots)
--
-- Owner, 2026-07-15. Prod showed ~10 duplicate pending_intake lot PAIRS: two
-- rows, consecutive lot_codes, created 0-1s apart, one linked to the manifest
-- import_row and its twin an orphan (no manifest link, sometimes no sticker).
-- Root cause (verified against prod + code):
--   1. create_draft_lot has NO idempotency — every call mints a new lot (the
--      (operator_id, external_code) UNIQUE was dropped in 0058 on purpose).
--   2. The Quick-Lot client can invoke createLot twice for one scan (the
--      auto-create timer + a confirm/photo submit each fire; the ref mutex only
--      SERIALIZES concurrent calls, it doesn't DEDUPE sequential ones).
--   3. The manifest re-lot guard (mark_import_row_lotted, 0153) ran
--      fire-and-forget and NON-atomically AFTER create (quick.tsx), so the
--      second create re-matched the still-'pending' row and minted a twin.
--
-- Fix: fold the pending->lotted flip INTO create_draft_lot and make it atomic.
-- When p_import_row_id is supplied, the function locks that import_row
-- (FOR UPDATE); if it is ALREADY lotted it returns the EXISTING lot instead of
-- inserting (idempotent — a second call for the same box is a no-op), otherwise
-- it inserts the lot and flips the row in the SAME transaction. Two real units
-- come from two different import_rows (different tracking) and are unaffected.
--
-- New last arg p_import_row_id UUID DEFAULT NULL — NULL preserves the exact
-- prior behavior for non-manifest lotting (AI scan / catalog / bare / manual).
-- Every other line of the 0188 body is carried over verbatim.
--
-- Transactional (BEGIN/COMMIT) like 0188; DROP the 20-arg form first (mig-0188
-- pattern) so the named-arg boundary stays unambiguous.

BEGIN;

DROP FUNCTION IF EXISTS public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text, text, text, text
);

CREATE OR REPLACE FUNCTION public.create_draft_lot(
  p_operator_id        uuid,
  p_title              text,
  p_description        text,
  p_category           text,
  p_category_id        uuid,
  p_condition          lot_condition,
  p_msrp_cents         bigint,
  p_starting_bid_cents bigint,
  p_photo_urls         text[],
  p_external_code      text,
  p_source             text,
  p_brand              text DEFAULT NULL,
  p_model              text DEFAULT NULL,
  p_asin               text DEFAULT NULL,
  p_fnsku              text DEFAULT NULL,
  p_lpn                text DEFAULT NULL,
  p_vendor             text DEFAULT NULL,
  p_product_sku        text DEFAULT NULL,
  p_site_sku           text DEFAULT NULL,
  p_manufacture_sku    text DEFAULT NULL,
  -- 0269: manifest provenance. When set, create is idempotent on this row and
  -- the pending->lotted flip happens atomically in this transaction.
  p_import_row_id      uuid DEFAULT NULL
)
RETURNS TABLE(out_id uuid, out_lot_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_op       UUID;
  v_caller_uid      UUID;
  v_seq             BIGINT;
  v_op_code         TEXT;
  v_lot_code        TEXT;
  v_lot_id          UUID;
  v_existing_lot_id UUID;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: not authenticated' USING ERRCODE = '28000';
  END IF;

  v_caller_op := current_operator_id();
  IF v_caller_op IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: caller is not operator staff'
      USING ERRCODE = '42501';
  END IF;
  IF v_caller_op IS DISTINCT FROM p_operator_id THEN
    RAISE EXCEPTION 'create_draft_lot: caller % cannot create lot for operator %',
      v_caller_op, p_operator_id USING ERRCODE = '42501';
  END IF;

  -- 0269: manifest idempotency. Lock the operator's import_row; if a lot was
  -- already minted for it (by a prior — possibly double-fired — call), return
  -- that lot unchanged instead of inserting a twin. The FOR UPDATE lock also
  -- serializes two concurrent calls for the same box: the loser waits, then
  -- sees lot_id set and returns it.
  IF p_import_row_id IS NOT NULL THEN
    SELECT lot_id INTO v_existing_lot_id
      FROM import_rows
     WHERE id = p_import_row_id
       AND operator_id = v_caller_op
     FOR UPDATE;

    IF v_existing_lot_id IS NOT NULL THEN
      SELECT lots.lot_code INTO v_lot_code FROM lots WHERE lots.id = v_existing_lot_id;
      out_id := v_existing_lot_id;
      out_lot_code := v_lot_code;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- 0066: NEW-VALUE RETURNING semantic aligned with next_lot_code.
  UPDATE operators
     SET next_lot_seq = next_lot_seq + 1
   WHERE id = p_operator_id
   RETURNING code, next_lot_seq INTO v_op_code, v_seq;

  IF v_op_code IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: operator % not found', p_operator_id
      USING ERRCODE = '02000';
  END IF;

  v_lot_code := v_op_code || '-' || lpad(v_seq::TEXT, 6, '0');

  -- 0154: vendor added alongside the previously-supported identity fields.
  -- 0188: product_sku / site_sku / manufacture_sku added the same way.
  -- Empty strings normalize to NULL so the lot_text_length CHECKs (0050) don't
  -- trip on "" extractions, matching brand/model/asin/fnsku/lpn handling.
  INSERT INTO lots (
    operator_id, auction_id, lot_number, warehouse_id,
    lot_code, title, description, category, category_id,
    condition, msrp_cents, starting_bid_cents, photo_urls,
    status, external_code, close_at, source,
    brand, model, asin, fnsku, lpn, vendor,
    product_sku, site_sku, manufacture_sku
  ) VALUES (
    p_operator_id, NULL, NULL, NULL,
    v_lot_code, p_title, p_description, p_category, p_category_id,
    COALESCE(p_condition, 'good'::lot_condition),
    p_msrp_cents, p_starting_bid_cents,
    COALESCE(p_photo_urls, ARRAY[]::TEXT[]),
    'pending_intake'::lot_status,
    p_external_code, NULL, p_source,
    NULLIF(TRIM(COALESCE(p_brand,  '')), ''),
    NULLIF(TRIM(COALESCE(p_model,  '')), ''),
    NULLIF(TRIM(COALESCE(p_asin,   '')), ''),
    NULLIF(TRIM(COALESCE(p_fnsku,  '')), ''),
    NULLIF(TRIM(COALESCE(p_lpn,    '')), ''),
    NULLIF(TRIM(COALESCE(p_vendor, '')), ''),
    NULLIF(TRIM(COALESCE(p_product_sku,     '')), ''),
    NULLIF(TRIM(COALESCE(p_site_sku,        '')), ''),
    NULLIF(TRIM(COALESCE(p_manufacture_sku, '')), '')
  )
  RETURNING lots.id INTO v_lot_id;

  -- 0269: atomic pending->lotted flip (replaces the fire-and-forget
  -- mark_import_row_lotted call in the client). Same transaction as the INSERT,
  -- so the row can never be re-matched by a second scan between create + flip.
  IF p_import_row_id IS NOT NULL THEN
    UPDATE import_rows
       SET status = 'lotted', lot_id = v_lot_id, lotted_at = now()
     WHERE id = p_import_row_id
       AND operator_id = v_caller_op
       AND lot_id IS NULL;
  END IF;

  -- 0076: heuristic backlink of recent unlinked ai_calls rows. See migration
  -- 0076 header for tradeoff rationale. SECURITY DEFINER + same-user filter
  -- (auth.uid()) means RLS doesn't block the UPDATE. Safe to no-op when the
  -- user has no recent unlinked AI activity.
  UPDATE ai_calls
     SET lot_id = v_lot_id
   WHERE user_id     = v_caller_uid
     AND operator_id = p_operator_id
     AND lot_id      IS NULL
     AND created_at  > NOW() - INTERVAL '2 minutes';

  out_id := v_lot_id;
  out_lot_code := v_lot_code;
  RETURN NEXT;
END;
$function$;

-- Re-grant on the new 21-arg signature exactly as create_draft_lot has always
-- been exposed (operator staff invoke it via the authenticated supabase client).
REVOKE ALL ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text, text, text, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text, text, text, text, uuid
) TO authenticated;

COMMENT ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text, text, text, text, uuid
) IS
  '0269: quick-lot draft creator. Mints lot_code, inserts a pending_intake lot. '
  'When p_import_row_id is set, it is idempotent on that manifest row (returns '
  'the existing lot instead of a duplicate) and flips pending->lotted atomically '
  'in the same transaction — killing the duplicate-lot race. 0154+0188 identity '
  'fields intact.';

COMMIT;
