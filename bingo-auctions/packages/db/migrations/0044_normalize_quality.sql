-- ============================================================================
-- 0044_normalize_quality — Bogus-identifier detection + lookup guard
--
-- Mirrors the TS isFakeUpc / isFakeAsin helpers from
--   packages/domain-lotting/src/normalize/upc.ts
-- into SQL so bulk DB-side operations reject the same patterns without
-- a round-trip through the TS layer.
--
-- Problem context:
--   MAC.BID's scrape data emits '000000000000' (12 zeros) in the `upc` field
--   when a product has no barcode on file. The pre-0044 normalize_upc() only
--   checked digit-length, so this placeholder passed validation and was stored
--   as upc='000000000000' in product_lookups. UPC scanner lookups against
--   that code returned a false-positive match for the seeded product
--   (PetAg Digestion and Immune Support Supplement). This migration closes
--   that gap at the SQL layer.
--
-- What's added:
--   1. is_fake_upc(text) BOOLEAN   — mirrors isFakeUpc(digits)
--   2. is_fake_asin(text) BOOLEAN  — mirrors isFakeAsin(asin)
--   3. normalize_upc(text) updated — rejects digits where is_fake_upc() is true
--   4. lookup_product_by_code(text) updated — fast-returns empty for fake codes
--
-- All functions are CREATE OR REPLACE — idempotent, safe to re-run.
-- ============================================================================

-- ── 1. is_fake_upc(text) BOOLEAN ─────────────────────────────────────────────
-- Input: a digits-only string of any length (caller does not need to pre-validate length).
-- Returns TRUE if the string matches any known bogus placeholder pattern.
--
-- Pattern checks (mirrors isFakeUpc in upc.ts):
--   P1. All same digit         — '000000000000', '999999999999'
--   P2. Sequential ascending   — '012345678901', '890123456789' (mod-10 wrap)
--   P3. Sequential descending  — '987654321098'
--   P4. Repeated sub-pattern   — period 2/3/4 chunks all equal
--   P5. Explicit blocklist     — known placeholder values in the wild
--
-- IMMUTABLE: pure function of its input, no DB reads.

CREATE OR REPLACE FUNCTION is_fake_upc(p_digits TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_len   INT    := length(p_digits);
  v_diffs INT[];
  v_chunk TEXT;
  v_i     INT;
  v_all_asc  BOOLEAN;
  v_all_desc BOOLEAN;
  v_diff  INT;
BEGIN
  -- ── P1: All same digit ────────────────────────────────────────────────────
  -- Postgres regex: ^ then a single char captured, then \1 repeated to $.
  IF p_digits ~ '^(.)\1+$' THEN
    RETURN TRUE;
  END IF;

  -- ── P2 & P3: Sequential ascending or descending (mod-10 aware) ───────────
  -- Build an array of adjacent differences. Normalise +9 → -1 and -9 → +1
  -- to handle the 9→0 and 0→9 wraparound in sequential strings.
  v_diffs := ARRAY[]::INT[];
  FOR v_i IN 2 .. v_len LOOP
    v_diff := ASCII(SUBSTRING(p_digits, v_i, 1)) - ASCII(SUBSTRING(p_digits, v_i - 1, 1));
    IF    v_diff =  9 THEN v_diff := -1;
    ELSIF v_diff = -9 THEN v_diff :=  1;
    END IF;
    v_diffs := array_append(v_diffs, v_diff);
  END LOOP;

  v_all_asc  := TRUE;
  v_all_desc := TRUE;
  FOR v_i IN 1 .. array_length(v_diffs, 1) LOOP
    IF v_diffs[v_i] <> 1  THEN v_all_asc  := FALSE; END IF;
    IF v_diffs[v_i] <> -1 THEN v_all_desc := FALSE; END IF;
  END LOOP;

  IF v_all_asc OR v_all_desc THEN
    RETURN TRUE;
  END IF;

  -- ── P4: Repeated sub-pattern (period 2, 3, 4) ────────────────────────────
  -- If the string equals its first-N chars repeated (v_len / period) times,
  -- it is a period-N repetition.
  FOREACH v_i IN ARRAY ARRAY[2, 3, 4] LOOP
    IF v_len % v_i = 0 THEN
      v_chunk := SUBSTRING(p_digits, 1, v_i);
      IF p_digits = REPEAT(v_chunk, v_len / v_i) THEN
        RETURN TRUE;
      END IF;
    END IF;
  END LOOP;

  -- ── P5: Explicit blocklist ────────────────────────────────────────────────
  IF p_digits IN (
    '123456789012',   -- canonical "test barcode"
    '012345678905',   -- GS1 sample UPC-A from documentation
    '888888888888',   -- placeholder from Chinese listing tools
    '123456789013',   -- common barcode-scanner test strip
    '000000000017'    -- Amazon internal placeholder (seen in FBA returns)
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION is_fake_upc(TEXT) IS
  'Returns TRUE for digit strings that match bogus placeholder patterns (all-same, sequential, repeated sub-pattern, explicit blocklist). Mirror of isFakeUpc() in normalize/upc.ts. Used by normalize_upc() and lookup_product_by_code(). IMMUTABLE — no DB reads.';


-- ── 2. is_fake_asin(text) BOOLEAN ────────────────────────────────────────────
-- Input: already-validated 10-char uppercase alphanumeric ASIN string.
-- Returns TRUE for known placeholder patterns.
--
-- Pattern checks (mirrors isFakeAsin in upc.ts):
--   P1. Chars 1-9 (suffix) all the same char — 'B000000000', 'BAAAAAAAAA'
--   P2. Full 10-char string is period-2 or period-5 repetition — 'BABABABABA'
--   P3. All-digit suffix is sequential ascending or descending
--   P4. Explicit blocklist

CREATE OR REPLACE FUNCTION is_fake_asin(p_asin TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_suffix TEXT := SUBSTRING(p_asin, 2);   -- chars 2-10 (9 chars)
  v_chunk  TEXT;
  v_period INT;
  v_diffs  INT[];
  v_i      INT;
  v_all_asc  BOOLEAN;
  v_all_desc BOOLEAN;
  v_diff   INT;
BEGIN
  -- ── P1: Suffix (chars 2-10) is all the same character ────────────────────
  -- 'B000000000', 'BAAAAAAAAA', 'B111111111'
  IF v_suffix ~ '^(.)\1+$' THEN
    RETURN TRUE;
  END IF;

  -- ── P2: Full 10-char ASIN is a period-2 or period-5 repetition ───────────
  -- 'BABABABABA' (period 2), and any period-5 repeat of a 2-char chunk.
  FOREACH v_period IN ARRAY ARRAY[2, 5] LOOP
    IF 10 % v_period = 0 THEN
      v_chunk := SUBSTRING(p_asin, 1, v_period);
      IF p_asin = REPEAT(v_chunk, 10 / v_period) THEN
        RETURN TRUE;
      END IF;
    END IF;
  END LOOP;

  -- ── P3: All-digit suffix is sequential ascending or descending ────────────
  -- 'B012345678'
  IF v_suffix ~ '^\d{9}$' THEN
    v_diffs := ARRAY[]::INT[];
    FOR v_i IN 2 .. 9 LOOP
      v_diff := ASCII(SUBSTRING(v_suffix, v_i, 1)) - ASCII(SUBSTRING(v_suffix, v_i - 1, 1));
      IF    v_diff =  9 THEN v_diff := -1;
      ELSIF v_diff = -9 THEN v_diff :=  1;
      END IF;
      v_diffs := array_append(v_diffs, v_diff);
    END LOOP;

    v_all_asc  := TRUE;
    v_all_desc := TRUE;
    FOR v_i IN 1 .. array_length(v_diffs, 1) LOOP
      IF v_diffs[v_i] <> 1  THEN v_all_asc  := FALSE; END IF;
      IF v_diffs[v_i] <> -1 THEN v_all_desc := FALSE; END IF;
    END LOOP;

    IF v_all_asc OR v_all_desc THEN
      RETURN TRUE;
    END IF;
  END IF;

  -- ── P4: Explicit ASIN blocklist ───────────────────────────────────────────
  IF p_asin IN (
    'B000000000',   -- Amazon internal placeholder / unassigned
    'B012345678',   -- sequential test value
    'B0TEST00001'   -- seen in sandbox environments
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION is_fake_asin(TEXT) IS
  'Returns TRUE for 10-char ASIN strings that match bogus placeholder patterns (repeated suffix, period-2/5 full-string repeat, sequential digit suffix, explicit blocklist). Mirror of isFakeAsin() in normalize/upc.ts. IMMUTABLE — no DB reads.';


-- ── 3. normalize_upc(text) — updated to reject fake patterns ─────────────────
-- Replaces the 0038 implementation. Same interface, same caller contract —
-- returns NULL on bogus input and NULL on fake patterns.
--
-- Mirror of: normalizeUpc() in packages/domain-lotting/src/normalize/upc.ts

CREATE OR REPLACE FUNCTION normalize_upc(p_raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_digits TEXT := regexp_replace(p_raw, '[^0-9]', '', 'g');
BEGIN
  -- Length gate: must be 8 (UPC-E), 12 (UPC-A), 13 (EAN-13), or 14 (GTIN-14).
  IF length(v_digits) NOT IN (8, 12, 13, 14) THEN
    RETURN NULL;
  END IF;

  -- Bogus-pattern gate: reject obvious placeholders.
  IF is_fake_upc(v_digits) THEN
    RETURN NULL;
  END IF;

  RETURN v_digits;
END;
$$;

COMMENT ON FUNCTION normalize_upc(TEXT) IS
  'Strip non-digits; return only if length is 8/12/13/14 AND is_fake_upc() is false. Mirror of normalizeUpc() in normalize/upc.ts. Updated in 0044 to reject bogus placeholder patterns.';


-- ── 4. lookup_product_by_code(text) — fast-return for fake codes ─────────────
-- Replaces the 0043 implementation. Adds a is_fake_upc() early-exit guard
-- before the UPC branch so callers get an empty result set immediately
-- instead of a legitimate row that happened to share the placeholder digits.
--
-- All other resolution steps (ASIN, FNSKU, LPN, MPN, external_codes) are
-- unchanged; the fake-code guard only applies to the UPC path since that is
-- where placeholder pollution has been observed.
--
-- Idempotent: CREATE OR REPLACE.

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
  -- 0044 addition: reject fake/placeholder digit strings before hitting the PK.
  IF length(v_digits) IN (8, 12, 13, 14) AND v_clean ~ '^[0-9\-\s]+$' THEN
    -- Fast-return empty for obviously bogus codes — no DB lookup needed.
    IF is_fake_upc(v_digits) THEN
      RETURN;
    END IF;

    RETURN QUERY
      SELECT * FROM product_lookups WHERE upc = v_digits LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- ── 2. ASIN ────────────────────────────────────────────────────────────
  -- Amazon Standard Identification Number: exactly 10 uppercase alphanumeric
  -- chars beginning with B0. (Older ASINs start with other letters but B0
  -- covers the vast majority of consumer electronics manufactured post-2010.)
  IF v_clean ~ '^[Bb]0[A-Za-z0-9]{8}$' THEN
    -- Reject fake ASINs (B000000000 etc.) before the index lookup.
    IF NOT is_fake_asin(upper(v_clean)) THEN
      RETURN QUERY
        SELECT * FROM product_lookups WHERE asin = upper(v_clean) LIMIT 1;
      IF FOUND THEN RETURN; END IF;
    END IF;
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
  'Multi-identifier product lookup. Resolves UPC → ASIN → FNSKU → LPN → MPN → external_codes in order. Returns the first matching product_lookups row, or empty set on miss. UPC and ASIN paths guard against fake placeholder codes via is_fake_upc() / is_fake_asin() (added in 0044). STABLE — no side-effects. Call via supabase.rpc(''lookup_product_by_code'', { p_code: code }).';

-- Re-grant (SECURITY DEFINER function permissions are on the function object itself,
-- so we must re-GRANT after CREATE OR REPLACE to keep existing grants).
REVOKE ALL ON FUNCTION lookup_product_by_code(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_product_by_code(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION lookup_product_by_code(TEXT) TO service_role;


-- ── Self-mark ─────────────────────────────────────────────────────────────────

INSERT INTO _schema_migrations (filename, applied_by)
VALUES ('0044_normalize_quality.sql', 'manual')
ON CONFLICT (filename) DO NOTHING;
