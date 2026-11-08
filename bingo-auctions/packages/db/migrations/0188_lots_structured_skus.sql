-- migration 0188 — round-trip the structured SKU columns from import_rows onto lots
--
-- WHY (Stream A — close the manifest→lot→bidder loop)
-- ---------------------------------------------------------------------------
-- 0186 added product_sku / site_sku / manufacture_sku to import_rows and taught
-- find_import_row_by_scan to probe them; 0187 backfilled them onto the existing
-- pending rows from raw_data. But those columns live ONLY on import_rows — they
-- never made it onto `lots`. The new Identifiers UI on the public lot page
-- (apps/operator-web .../lot/[code]/page.tsx) and the bidder app
-- (apps/bidder-app/app/lot/[id].tsx) already surface brand/model/upc/asin/
-- fnsku/lpn/mpn, but cannot show the real product SKU because the lot row has
-- no such column. This migration closes that loop:
--   1. Adds the three columns to lots (additive, nullable).
--   2. Extends create_draft_lot — the lot-creation RPC that copies identity
--      fields onto a new lot — to also carry the three SKUs (mirrors exactly
--      how 0154 added p_vendor: three trailing TEXT params DEFAULT NULL + three
--      NULLIF/TRIM column copies in the INSERT, nothing else changed).
--   3. Backfills the SKUs onto EXISTING lots from their source import_row.
--
-- WHICH function copies identifiers? (the non-obvious part)
-- ---------------------------------------------------------------------------
-- The pre-0142 manifest-mint path (intake_lot_to_bin / batch_intake_lot_to_bin)
-- USED to INSERT a lot and copy v_row.asin/fnsku/lpn/brand/model. W4 (mig 0142)
-- REMOVED that silent-mint path entirely — those two RPCs now only resolve an
-- EXISTING lot and update its bin/status; they no longer INSERT into lots or
-- copy any identifier. So they are intentionally NOT touched here.
--
-- As of today the ONLY function that creates a lot AND copies brand/model/asin/
-- fnsku/lpn onto it is public.create_draft_lot (latest def: mig 0154, 17 args).
-- The Lotting client seeds it from a manifest row (lot_from_manifest 0142 /
-- find_import_row_by_tracking 0153) and links the source row back via
-- mark_import_row_lotted (0153, which sets import_rows.lot_id). So this migration
-- updates create_draft_lot, reproducing 0154's body VERBATIM and adding ONLY the
-- three SKU params + three column copies.
--
-- FK reality for the backfill
-- ---------------------------------------------------------------------------
-- There are TWO links between a lot and its manifest row:
--   • lots.import_row_id  → import_rows.id   (0029 forward FK). Only the removed
--     pre-0142 manifest-mint path ever set this, plus the 0068 backfill — so it
--     is NULL for every lot created through today's Lotting flow.
--   • import_rows.lot_id  → lots.id          (0029 back-pointer). This is what
--     the live flow actually sets (mark_import_row_lotted 0153, legacy
--     lot_import_rows 0029/0032). This is the canonical, populated link.
-- A backfill keyed only on lots.import_row_id would therefore match almost
-- nothing in prod. To actually round-trip the data we cover BOTH directions.
-- Both arms are NULL-guarded so the migration is idempotent and re-runnable.
-- ============================================================================

BEGIN;

-- ── 1. Columns ───────────────────────────────────────────────────────────────
-- All nullable, additive. IF NOT EXISTS keeps this re-runnable. TEXT to match
-- the import_rows.product_sku / site_sku / manufacture_sku columns (0186).
ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS product_sku     TEXT,
  ADD COLUMN IF NOT EXISTS site_sku        TEXT,
  ADD COLUMN IF NOT EXISTS manufacture_sku TEXT;

COMMENT ON COLUMN public.lots.product_sku IS
  '0188: cross-vendor item-level product SKU (Wayfair ProductSKU / Walmart-'
  'Lowe''s SKU / Amazon MSKU). Round-tripped from import_rows.product_sku (0186) '
  'at lotting / via the 0188 backfill. Surfaced in the bidder Identifiers UI.';
COMMENT ON COLUMN public.lots.site_sku IS
  '0188: site/merchant SKU (Wayfair SiteSKU / Amazon merchant SKU). '
  'Round-tripped from import_rows.site_sku (0186).';
COMMENT ON COLUMN public.lots.manufacture_sku IS
  '0188: manufacturer SKU (Wayfair ManufactureSKU / Lowe''s-Walmart Model / MPN). '
  'Round-tripped from import_rows.manufacture_sku (0186).';

-- ── 2. create_draft_lot — add three trailing SKU params (18→20 args) ─────────
-- The exact 17-arg signature from 0154 must be DROPped first: a CREATE OR
-- REPLACE with a different arg count creates a SECOND overload alongside the
-- old one, leaving named-arg callers ambiguous. DROP IF EXISTS makes this
-- re-runnable (on re-run the 17-arg form is already gone — no-op — and the
-- 20-arg CREATE OR REPLACE below refreshes in place).
--
-- Body below is reproduced VERBATIM from 0154's definition. The ONLY changes:
--   • three new trailing params  p_product_sku / p_site_sku / p_manufacture_sku
--     TEXT DEFAULT NULL  (existing callers that omit them store NULL, exactly
--     as p_vendor behaves — see 0154 header).
--   • three new columns in the INSERT column list + three matching
--     NULLIF(TRIM(COALESCE(...,''),'')) values, alongside vendor.
-- No other logic touched (seq increment, ai_calls backlink, grants all intact).
DROP FUNCTION IF EXISTS public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text
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
  p_manufacture_sku    text DEFAULT NULL
)
RETURNS TABLE(out_id uuid, out_lot_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_op  UUID;
  v_caller_uid UUID;
  v_seq        BIGINT;
  v_op_code    TEXT;
  v_lot_code   TEXT;
  v_lot_id     UUID;
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

-- DROP removed the prior grants; re-grant on the new 20-arg signature exactly
-- as create_draft_lot has always been exposed (operator staff invoke it via
-- the authenticated supabase client).
REVOKE ALL ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text, text, text, text
) TO authenticated;

COMMENT ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text, text, text, text
) IS
  '0154 + 0188: quick-lot draft creator. Mints lot_code, inserts a '
  'pending_intake row with identity fields (brand/model/asin/fnsku/lpn) + '
  'structured SKUs (product_sku/site_sku/manufacture_sku, 0188) + provenance '
  '(source = VRID/Load/origin facility, vendor = supplier). Operator-staff '
  'only; bypasses RLS via SECURITY DEFINER + caller-op check.';

-- ── 3. Backfill existing lots from their source import_row ───────────────────
-- Idempotent: only writes lots still missing a SKU, only from rows that carry
-- one. Two arms, one per link direction (see header). COALESCE preserves any
-- value a lot already has and only fills the gaps.

-- 3a. Canonical back-pointer: import_rows.lot_id → lots.id (the live link set
--     by mark_import_row_lotted / lot_import_rows). This is the one that
--     actually matches today's Lotting-flow lots.
UPDATE public.lots l
   SET product_sku     = COALESCE(l.product_sku,     ir.product_sku),
       site_sku        = COALESCE(l.site_sku,        ir.site_sku),
       manufacture_sku = COALESCE(l.manufacture_sku, ir.manufacture_sku)
  FROM public.import_rows ir
 WHERE ir.lot_id = l.id
   AND (l.product_sku IS NULL OR l.site_sku IS NULL OR l.manufacture_sku IS NULL)
   AND (ir.product_sku IS NOT NULL OR ir.site_sku IS NOT NULL OR ir.manufacture_sku IS NOT NULL);

-- 3b. Forward FK: lots.import_row_id → import_rows.id (pre-0142 manifest-mint
--     lots + the 0068 backfill). Covers any lot whose forward FK is set.
UPDATE public.lots l
   SET product_sku     = COALESCE(l.product_sku,     ir.product_sku),
       site_sku        = COALESCE(l.site_sku,        ir.site_sku),
       manufacture_sku = COALESCE(l.manufacture_sku, ir.manufacture_sku)
  FROM public.import_rows ir
 WHERE l.import_row_id = ir.id
   AND (l.product_sku IS NULL OR l.site_sku IS NULL OR l.manufacture_sku IS NULL)
   AND (ir.product_sku IS NOT NULL OR ir.site_sku IS NOT NULL OR ir.manufacture_sku IS NOT NULL);

COMMIT;
