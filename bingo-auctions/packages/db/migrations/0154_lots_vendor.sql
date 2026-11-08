-- ============================================================================
-- Migration 0154 — lots.vendor (supplier) as a column distinct from lots.source
--
-- Team decision (2026-05-27): operators want TWO separate provenance columns
-- on a lot:
--   • lots.source  (exists, mig 0055)  = the LOAD identity / origin — VRID,
--                                        Load ID, or vendor facility code
--                                        (e.g. lex1, btr1, "lowes returns GA").
--   • lots.vendor  (NEW, this file)    = the supplier / retailer the goods
--                                        came from (Amazon, Lowe's, Wayfair).
-- These are distinct from lots.warehouse_id, which is the OPERATOR'S own
-- building (drives timezone, picker location, etc.).
--
-- This migration:
--   1. ALTER TABLE lots ADD COLUMN vendor TEXT (nullable; backfill is null).
--   2. Partial index (operator_id, vendor) WHERE vendor IS NOT NULL — feeds
--      the operator Inventory vendor filter (most lots will be null early on,
--      so partial saves space).
--   3. Re-creates create_draft_lot with a trailing p_vendor TEXT DEFAULT NULL
--      (17th parameter). Arg count changes (16 -> 17), so CREATE OR REPLACE
--      would yield a SECOND overload -- DROP the exact 16-arg signature first,
--      then CREATE the 17-arg version, then re-GRANT EXECUTE (DROP loses
--      grants). Body is the current prod definition (pulled via
--      pg_get_functiondef) with vendor added to the INSERT column list and
--      values; empty-string vendor normalizes to NULL via NULLIF/TRIM, same
--      as brand/model/asin/fnsku/lpn.
--
-- Existing callers (which omit p_vendor) keep working -- DEFAULT NULL stores
-- NULL exactly as if the column weren't set. The mobile lotting session will
-- start passing p_vendor in a follow-up code PR once captured in the session
-- sheet.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. lots.vendor column + filter index
-- ---------------------------------------------------------------------------
ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS vendor TEXT;

COMMENT ON COLUMN public.lots.vendor IS
  '0154: supplier / retailer the lot came from (e.g. Amazon, Lowe''s, Wayfair). '
  'Distinct from lots.source (VRID / Load ID / origin facility) and '
  'lots.warehouse_id (the operator''s own building). Set at lotting; NULL '
  'when unknown.';

CREATE INDEX IF NOT EXISTS lots_vendor_idx
  ON public.lots (operator_id, vendor)
  WHERE vendor IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. create_draft_lot -- add trailing p_vendor TEXT DEFAULT NULL (17th arg)
-- ---------------------------------------------------------------------------
-- Drop the exact existing 16-arg signature first. CREATE OR REPLACE with a
-- DIFFERENT arg count creates a new overload alongside the old one, which
-- would leave named-arg callers ambiguous. DROP IF EXISTS so this migration
-- is re-runnable: on re-run the old 16-arg is gone (no-op), and the 17-arg
-- CREATE OR REPLACE below refreshes the function in place.
DROP FUNCTION IF EXISTS public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text
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
  p_vendor             text DEFAULT NULL
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
  -- Empty strings normalize to NULL so the lot_text_length CHECKs (0050) don't
  -- trip on "" extractions, matching brand/model/asin/fnsku/lpn handling.
  INSERT INTO lots (
    operator_id, auction_id, lot_number, warehouse_id,
    lot_code, title, description, category, category_id,
    condition, msrp_cents, starting_bid_cents, photo_urls,
    status, external_code, close_at, source,
    brand, model, asin, fnsku, lpn, vendor
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
    NULLIF(TRIM(COALESCE(p_vendor, '')), '')
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

-- DROP removed the prior grants; re-grant on the new 17-arg signature exactly
-- as create_draft_lot has always been exposed (operator staff invoke it via
-- the authenticated supabase client).
REVOKE ALL ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text
) TO authenticated;

COMMENT ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text
) IS
  '0154: quick-lot draft creator. Mints lot_code, inserts a pending_intake row '
  'with identity fields (brand/model/asin/fnsku/lpn) + provenance '
  '(source = VRID/Load/origin facility, vendor = supplier). Operator-staff '
  'only; bypasses RLS via SECURITY DEFINER + caller-op check.';

COMMIT;
