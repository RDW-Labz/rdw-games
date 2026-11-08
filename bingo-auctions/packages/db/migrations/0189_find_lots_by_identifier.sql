-- migration 0189 — find_lots_by_identifier (bidder/staff lookup by scanned/typed code)
--
-- WHY (Stream D — "find lots by identifier")
-- ---------------------------------------------------------------------------
-- Bidders and staff often have a physical product identifier in hand — a UPC
-- off the box, an Amazon ASIN/FNSKU/LPN sticker, an operator external_code, or
-- a manufacturer Model/MPN — and want to jump straight to the matching live
-- lot. The mobile browse search runs full-text search on lots.search_tsv only
-- (title/description), which does NOT index any of the identifier columns, so
-- typing a UPC or ASIN there always returns "no lots". This RPC closes that gap
-- with a direct, indexed-ish exact-match probe across the identifier columns
-- that ALREADY exist on lots.
--
-- IDENTIFIER COLUMNS PROBED (all pre-existing on public.lots):
--   upc           — mig 0103 (digits-only UPC-8/12/13/14)
--   asin          — mig 0032 (Amazon product identifier)
--   fnsku         — mig 0032 (Amazon Fulfillment Network SKU)
--   lpn           — mig 0032 (Amazon License Plate Number, unit-level)
--   external_code — mig 0023 (operator's pre-existing identifier / SKU-ish)
--   model         — mig 0032 (manufacturer model number)
--   mpn           — mig 0137 (manufacturer part number)
-- NOTE: product_sku / site_sku / manufacture_sku are NOT probed here. Those
-- columns live on import_rows (mig 0186/0187), NOT on lots, so referencing them
-- would fail to compile on a fresh DB. This RPC is intentionally limited to the
-- identifier columns lots carries today.
--
-- SECURITY MODEL — SECURITY INVOKER (the default; explicit here for clarity):
--   Unlike get_recent_wins (mig 0126, SECURITY DEFINER), this function runs as
--   the *caller*, so the caller's RLS on lots governs row visibility:
--     * bidders  → lots_bidder_read_published (final mig 0181): only
--                  scheduled/live/won/unsold/relisted lots, early-access +
--                  demo guards applied. A bidder can never see another
--                  operator's draft/pending_intake inventory through this RPC.
--     * staff    → lots_staff_read (mig 0133): only their own operator's lots.
--   This is exactly the desired behavior, so NO SECURITY DEFINER + no manual
--   operator/auth guards are needed — RLS does the scoping. STABLE because it
--   only reads. SET search_path = public hardens name resolution.
--
-- RETURN SHAPE — RETURNS TABLE of a public-safe column allowlist (mirrors the
-- get_recent_wins approach) rather than RETURNS SETOF lots, so the function's
-- output is an explicit, stable contract and never widens to internal lots
-- columns (winner_bidder_id, reserve, cost, etc.).
--
-- MATCHING — case-insensitive exact match (lower(col) = lower(trimmed)) with
-- the candidate trimmed of surrounding whitespace. p_kind narrows which columns
-- are probed (default 'auto' = all of them). Empty/blank identifier returns 0
-- rows. Ordered live-first then soonest-closing; capped at 50.
--
-- Risk: low. Pure additive read-only function; no schema change, no data write,
-- no change to any existing function or policy.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.find_lots_by_identifier(
  p_identifier TEXT,
  p_kind       TEXT DEFAULT 'auto'
)
RETURNS TABLE (
  id                 UUID,
  lot_code           TEXT,
  title              TEXT,
  current_bid_cents  BIGINT,
  starting_bid_cents BIGINT,
  close_at           TIMESTAMPTZ,
  status             TEXT,
  photo_urls         TEXT[],
  auction_id         UUID
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_q    TEXT := lower(TRIM(COALESCE(p_identifier, '')));
  v_kind TEXT := lower(TRIM(COALESCE(p_kind, 'auto')));
BEGIN
  -- Empty / blank identifier → no rows (avoids a full-table lower() scan
  -- matching nothing useful, and gives the client a clean [] result).
  IF v_q = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    l.id,
    l.lot_code,
    l.title,
    l.current_bid_cents,
    l.starting_bid_cents,
    l.close_at,
    l.status,
    l.photo_urls,
    l.auction_id
  FROM public.lots l
  WHERE
    CASE v_kind
      -- Single-column kinds: probe just that identifier.
      WHEN 'upc'   THEN lower(l.upc)           = v_q
      WHEN 'asin'  THEN lower(l.asin)          = v_q
      WHEN 'fnsku' THEN lower(l.fnsku)         = v_q
      WHEN 'lpn'   THEN lower(l.lpn)           = v_q
      -- Model-ish: manufacturer model / part number / operator external code.
      WHEN 'model' THEN lower(l.model)         = v_q
                     OR lower(l.mpn)           = v_q
                     OR lower(l.external_code) = v_q
      -- SKU-ish: the SKU-shaped columns lots currently has.
      WHEN 'sku'   THEN lower(l.external_code) = v_q
                     OR lower(l.model)         = v_q
      -- 'auto' (and any unrecognized kind) → probe every identifier column.
      ELSE              lower(l.upc)           = v_q
                     OR lower(l.asin)          = v_q
                     OR lower(l.fnsku)         = v_q
                     OR lower(l.lpn)           = v_q
                     OR lower(l.external_code) = v_q
                     OR lower(l.model)         = v_q
                     OR lower(l.mpn)           = v_q
    END
  ORDER BY (l.status = 'live') DESC, l.close_at ASC NULLS LAST
  LIMIT 50;
END;
$function$;

COMMENT ON FUNCTION public.find_lots_by_identifier(TEXT, TEXT) IS
  'Stream D (mig 0189). Find lots by a scanned/typed product identifier. '
  'SECURITY INVOKER so the caller''s RLS on lots governs visibility (bidders '
  'see published/live lots via lots_bidder_read_published; staff see their '
  'operator''s lots via lots_staff_read). Case-insensitive exact match, trimmed. '
  'p_kind: auto=all | upc | asin | fnsku | lpn | model (model/mpn/external_code) '
  '| sku (external_code/model). Probes ONLY identifier columns present on lots '
  '(upc, asin, fnsku, lpn, external_code, model, mpn) — NOT import_rows''s '
  'product_sku/site_sku/manufacture_sku. Live-first, soonest-closing, LIMIT 50.';

-- Grant to authenticated (logged-in bidders + staff) and anon (public browse;
-- RLS still applies, so anon sees only what its policies permit). Mirrors the
-- get_recent_wins grant pattern (mig 0126).
GRANT EXECUTE ON FUNCTION public.find_lots_by_identifier(TEXT, TEXT) TO authenticated, anon;
