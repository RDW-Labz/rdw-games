-- ============================================================================
-- 0042 — product_lookups: multi-identifier columns + indexes
--
-- Transforms product_lookups from a UPC-only cache into the platform's
-- canonical product catalog. Any identifier (UPC, ASIN, FNSKU, LPN, MPN,
-- or operator-supplied custom codes) now resolves to the same normalized
-- product row.
--
-- Design decisions:
--   • UPC TEXT PRIMARY KEY is KEPT as the upsert key. It is the most
--     universal identifier (every barcode scanner emits one) and its
--     fixed-format digit string makes natural dedup trivial.
--   • For rows that have no UPC (ASIN-only, FNSKU-only, etc.) the caller
--     synthesizes a prefixed PK: 'asin:<ASIN>', 'fnsku:<FNSKU>', etc.
--     This is explicitly a short-term hack — see the FIXME below.
--   • All new identifier columns are sparse/nullable with PARTIAL indexes
--     so the index only grows as rows are populated. A 200k-row catalog
--     where 30% have ASINs costs far less index space than a full btree.
--   • external_codes is a TEXT[] GIN-indexed array — catch-all for any
--     supplier SKU, asset tag, or future identifier type the platform
--     doesn't know about yet.
--
-- FIXME (v2): The synthetic PK approach ('asin:...') is kludgy because it
-- embeds type information in what should be an opaque key. The correct
-- long-term schema is:
--   product_catalog (id UUID PRIMARY KEY, ...)
--   product_identifiers (catalog_id UUID FK, type TEXT, code TEXT, UNIQUE(type,code))
-- That gives clean multi-row, multi-type identifier storage with proper
-- conflicts and deduplicated catalog rows. Migrate when row counts justify
-- the join overhead (~10M+ rows). Flag: "product_catalog_v2".
-- ============================================================================

-- New identifier columns.
ALTER TABLE product_lookups
  ADD COLUMN IF NOT EXISTS asin          TEXT,
  ADD COLUMN IF NOT EXISTS fnsku         TEXT,
  ADD COLUMN IF NOT EXISTS lpn           TEXT,
  ADD COLUMN IF NOT EXISTS mpn           TEXT,
  ADD COLUMN IF NOT EXISTS external_codes TEXT[] NOT NULL DEFAULT '{}';

-- Sparse partial indexes — excluded when the column IS NULL so rows without
-- that identifier don't bloat the index. Very cheap for a catalog where many
-- rows have UPC but only some have ASIN, fewer have FNSKU, etc.

CREATE INDEX IF NOT EXISTS product_lookups_asin_idx
  ON product_lookups (asin)
  WHERE asin IS NOT NULL;

CREATE INDEX IF NOT EXISTS product_lookups_fnsku_idx
  ON product_lookups (fnsku)
  WHERE fnsku IS NOT NULL;

CREATE INDEX IF NOT EXISTS product_lookups_lpn_idx
  ON product_lookups (lpn)
  WHERE lpn IS NOT NULL;

-- MPN is case-insensitive (manufacturers are inconsistent: 'DCD771C2' vs
-- 'dcd771c2'). Store raw, index lower() so the RPC can do lower(mpn) = lower(?).
CREATE INDEX IF NOT EXISTS product_lookups_mpn_idx
  ON product_lookups (lower(mpn))
  WHERE mpn IS NOT NULL;

-- GIN array index — supports the @> (contains) operator used in the RPC
-- catch-all step: "WHERE external_codes @> ARRAY['SKU-12345']"
CREATE INDEX IF NOT EXISTS product_lookups_external_codes_gin
  ON product_lookups USING GIN (external_codes);

-- Column comments for schema browsers / future developers.
COMMENT ON COLUMN product_lookups.asin IS
  'Amazon Standard Identification Number (B0xxxxxxxx). 10 uppercase alphanumeric chars. Indexed via product_lookups_asin_idx.';

COMMENT ON COLUMN product_lookups.fnsku IS
  'Amazon Fulfillment Network SKU (X00xxxxxxxx). Per-MSKU identifier on FBA labels. Indexed via product_lookups_fnsku_idx.';

COMMENT ON COLUMN product_lookups.lpn IS
  'Amazon License Plate Number — per-unit label on Amazon FC return shipments. Variable format; always uppercase alphanumeric. Indexed via product_lookups_lpn_idx.';

COMMENT ON COLUMN product_lookups.mpn IS
  'Manufacturer part number / model number (e.g. DCD771C2, MK-HE720). Case-insensitive index on lower(mpn). Indexed via product_lookups_mpn_idx.';

COMMENT ON COLUMN product_lookups.external_codes IS
  'Catch-all TEXT[] for user-supplied identifiers: supplier SKU, asset tag, internal lot code, etc. GIN-indexed so ANY-element lookup is fast: WHERE external_codes @> ARRAY[$1].';
