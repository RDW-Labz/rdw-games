-- ============================================================================
-- 0043 — lookup_product_by_code: multi-identifier resolution RPC
--
-- A single SQL function that resolves any known identifier to a
-- product_lookups row. Clients call this via supabase.rpc() for a single
-- round-trip regardless of identifier type.
--
-- Resolution order (most-specific → least-specific):
--   1. UPC — digit-only, lengths 8/12/13/14. PK lookup, O(1).
--   2. ASIN — B0 prefix + 8 alphanumeric chars. Partial index lookup.
--   3. FNSKU — X + 9 uppercase alphanumeric. Partial index lookup.
--   4. LPN — Amazon FC return label. Partial index lookup (catch-all step).
--   5. MPN — case-insensitive manufacturer part number. Functional index.
--   6. external_codes — GIN array containment for catch-all custom codes.
--
-- The function is STABLE (no side-effects, same inputs → same output within
-- a transaction). It does NOT insert missing rows — that remains the
-- responsibility of the TS lookup layer so we keep enrichment logic in one
-- place.
--
-- Why SQL not TypeScript?
--   Keeping the cascade in SQL means:
--   a) A single network round-trip from the JS client.
--   b) The ordering logic is co-located with the indexes that enforce it.
--   c) Other Postgres callers (triggers, other RPCs, direct psql queries)
--      all use the same resolution path without copying logic.
--
-- Idempotent: CREATE OR REPLACE — safe to re-run on any environment.
-- ============================================================================

CREATE OR REPLACE FUNCTION lookup_product_by_code(p_code TEXT)
RETURNS SETOF product_lookups
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean  TEXT := TRIM(p_code);
  v_digits TEXT := regexp_replace(TRIM(p_code), '[^0-9]', '', 'g');
BEGIN
  -- Guard: nothing to look up.
  IF v_clean = '' OR v_clean IS NULL THEN
    RETURN;
  END IF;

  -- ── 1. UPC / EAN / GTIN ────────────────────────────────────────────────
  -- Digit-only strings of common barcode lengths. The UPC column is the PK
  -- so this is a btree point-lookup — sub-millisecond at any row count.
  IF length(v_digits) IN (8, 12, 13, 14) AND v_clean ~ '^[0-9\-\s]+$' THEN
    RETURN QUERY
      SELECT * FROM product_lookups WHERE upc = v_digits LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- ── 2. ASIN ────────────────────────────────────────────────────────────
  -- Amazon Standard Identification Number: exactly 10 uppercase alphanumeric
  -- chars beginning with B0. (Older ASINs start with other letters but B0
  -- covers the vast majority of consumer electronics manufactured post-2010.)
  IF v_clean ~ '^[Bb]0[A-Za-z0-9]{8}$' THEN
    RETURN QUERY
      SELECT * FROM product_lookups WHERE asin = upper(v_clean) LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- ── 3. FNSKU ───────────────────────────────────────────────────────────
  -- Fulfillment Network SKU: X followed by 9 uppercase alphanumeric chars.
  -- Common form: X00xxxxxxx. The partial index on fnsku covers this.
  IF v_clean ~ '^[Xx][0-9A-Za-z]{9}$' THEN
    RETURN QUERY
      SELECT * FROM product_lookups WHERE fnsku = upper(v_clean) LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- ── 4. LPN (License Plate Number) ─────────────────────────────────────
  -- Amazon FC return labels. Format varies; generally uppercase alphanumeric,
  -- often starts with LP or contains a warehouse prefix. We try an exact
  -- upper-cased match against the lpn column.
  RETURN QUERY
    SELECT * FROM product_lookups WHERE lpn = upper(v_clean) LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- ── 5. MPN (manufacturer part / model number) ─────────────────────────
  -- Case-insensitive exact match. The functional index on lower(mpn) makes
  -- this fast without requiring the caller to normalize casing.
  RETURN QUERY
    SELECT * FROM product_lookups WHERE lower(mpn) = lower(v_clean) LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- ── 6. external_codes catch-all ────────────────────────────────────────
  -- GIN array containment: "does this row's external_codes array contain
  -- exactly this string?". Operators upload arbitrary supplier SKUs here.
  -- The GIN index from 0042 makes this O(log n) rather than a seq scan.
  RETURN QUERY
    SELECT * FROM product_lookups WHERE external_codes @> ARRAY[v_clean] LIMIT 1;
END;
$$;

COMMENT ON FUNCTION lookup_product_by_code(TEXT) IS
  'Multi-identifier product lookup. Resolves UPC → ASIN → FNSKU → LPN → MPN → external_codes in order. Returns the first matching product_lookups row, or empty set on miss. STABLE — no side-effects. Call via supabase.rpc(''lookup_product_by_code'', { p_code: code }).';

-- Grant access: authenticated users can call (matches product_lookups SELECT policy).
-- SECURITY DEFINER so RLS on the underlying table doesn't interfere with the
-- function's own SELECT path (the RLS policy already permits authed reads).
REVOKE ALL ON FUNCTION lookup_product_by_code(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_product_by_code(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION lookup_product_by_code(TEXT) TO service_role;
