-- ============================================================================
-- 0037_competitor_lots — competitive intelligence scrape cache.
--
-- Stores raw scraped data from competitor auction platforms (MAC.BID,
-- BidFTA, Nellis, etc.) at 1M+ row scale. This table is intentionally
-- a READ model: the platform's own products live in lots/import_rows;
-- this table exists purely as competitive signal (price comps, category
-- trends, bid velocity analysis).
--
-- Design decisions:
--
--   • Composite PK (source, source_id) — no auto-increment UUID needed;
--     the scraper's natural key is the canonical identity.
--
--   • All prices as BIGINT cents, never REAL — eliminates float drift
--     on aggregation queries across 1M+ rows.
--
--   • image_urls TEXT[] (source URLs only) — Supabase Storage mirroring
--     is prohibitively expensive at this scale. Scraper images are
--     external CDN links; bidder-facing images stay in lots.photo_urls.
--     isSafeImageUrl() is enforced at ingestion time in the TS layer.
--
--   • raw_json JSONB — full source response preserved for forensics and
--     re-processing without a re-scrape.
--
--   • No generated `closed` column — Postgres requires generated expressions
--     to be IMMUTABLE, and now() is volatile. Queries derive closed-state
--     directly: `WHERE closes_at IS NOT NULL AND closes_at < now()`. The
--     `final_bid_cents IS NOT NULL` filter alone is enough for sold-comps
--     since only closed lots ever have a final bid recorded.
--
--   • category_id nullable with ON DELETE SET NULL — alias-resolved when
--     the scraper inserts; NULL is acceptable until a later enrichment pass.
--
-- Indexes are LEFT COMMENTED OUT at the bottom of this file. Run them
-- AFTER the initial bulk load (currently ~295k rows) to avoid index churn
-- during insert. See "Post-load index commands" section at end of file.
-- ============================================================================

-- pg_trgm is required for the GIN trigram title index.
-- It may already be installed from migration 0027; IF NOT EXISTS is safe.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS competitor_lots (
  -- ── Identity ─────────────────────────────────────────────────────────────
  source          TEXT NOT NULL,              -- 'mac_bid' | 'bidfta' | 'nellis' | …
  source_id       TEXT NOT NULL,              -- platform's own lot identifier
  PRIMARY KEY (source, source_id),

  -- ── Normalized product identity ──────────────────────────────────────────
  title           TEXT NOT NULL,
  description     TEXT,
  brand           TEXT,                       -- trimmed; NULL on empty/"null" sentinels
  model           TEXT,
  upc             TEXT,                       -- digits-only: 8/12/13/14 chars or NULL

  -- ── Category resolution ───────────────────────────────────────────────────
  category_raw    TEXT,                       -- verbatim from scraper
  category_id     UUID REFERENCES categories(id) ON DELETE SET NULL,

  -- ── Pricing — INTEGER CENTS only, never floats ───────────────────────────
  msrp_cents      BIGINT,                     -- NULL when scraper didn't capture
  current_bid_cents BIGINT,                   -- live during auction window
  final_bid_cents BIGINT,                     -- populated on closed-lot re-scrape
  bid_count       INTEGER,
  discount_pct    REAL,                       -- (msrp - current_bid) / msrp × 100

  -- ── Lifecycle ─────────────────────────────────────────────────────────────
  condition       TEXT,                       -- normalized to platform vocab where possible
  location        TEXT,
  state           TEXT,                       -- two-letter US state code
  closes_at       TIMESTAMPTZ,
  -- closed-state is derived at query time: WHERE closes_at < now()
  -- (not stored — Postgres rejects mutable functions in generated columns)

  -- ── URL + images ─────────────────────────────────────────────────────────
  url             TEXT NOT NULL,
  -- Source URLs only. isSafeImageUrl() allowlist enforced at ingest (TS layer).
  -- No Supabase Storage mirroring — too expensive at 1M+ scale.
  image_urls      TEXT[] NOT NULL DEFAULT '{}',

  -- ── Forensics ─────────────────────────────────────────────────────────────
  raw_json        JSONB,                      -- full source response for re-processing

  -- ── Scraper timing ────────────────────────────────────────────────────────
  first_seen_at   TIMESTAMPTZ NOT NULL,
  last_seen_at    TIMESTAMPTZ NOT NULL,

  -- ── Record metadata ───────────────────────────────────────────────────────
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE competitor_lots IS
  'Scraped competitor auction data (MAC.BID, BidFTA, Nellis, etc.). Read-only competitive intelligence. Not operator-scoped — global signal. Prices always in integer cents. Source URLs only; no Storage mirror.';

-- (no closed column — derive at query time)

COMMENT ON COLUMN competitor_lots.upc IS
  'Digits-only, 8/12/13/14 chars. NULL when scraper could not extract or field was absent. Joins to product_lookups.upc.';

COMMENT ON COLUMN competitor_lots.raw_json IS
  'Full source response. Lets us re-derive any field without a re-scrape if the normalizer logic changes.';

-- ── Updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION competitor_lots_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS competitor_lots_touch_updated_at ON competitor_lots;
CREATE TRIGGER competitor_lots_touch_updated_at
  BEFORE UPDATE ON competitor_lots
  FOR EACH ROW EXECUTE FUNCTION competitor_lots_touch_updated_at();

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Competitive intelligence is global, not operator-scoped. Any authenticated
-- user (staff, bidder) may read. Writes only via the service role (scraper
-- runs server-side with the service key).

ALTER TABLE competitor_lots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS competitor_lots_authed_read ON competitor_lots;

CREATE POLICY competitor_lots_authed_read ON competitor_lots
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- No INSERT/UPDATE/DELETE policy for authenticated users. The scraper uses
-- the service-role key which bypasses RLS entirely.

-- ── Self-mark in schema migrations ──────────────────────────────────────────

INSERT INTO _schema_migrations (filename, applied_by)
VALUES ('0037_competitor_lots.sql', 'manual')
ON CONFLICT (filename) DO NOTHING;

-- ============================================================================
-- POST-LOAD INDEX COMMANDS
--
-- Run these AFTER the initial bulk load of ~295k rows (and any future bulk
-- backfills). Creating indexes on a populated table is faster than
-- maintaining them during bulk insert because Postgres builds the B-tree /
-- GIN in one pass rather than updating after every row.
--
-- Suggested procedure:
--   1. Insert all scraped rows with indexes commented out (as they are now).
--   2. Run the CREATE INDEX commands below in psql or the Supabase SQL editor.
--   3. For ongoing incremental scrapes (small inserts), the indexes are fine
--      to keep; index churn is only a concern for million-row batch loads.
--
-- Commands to run post-load:
-- ============================================================================

-- -- (1) Source + recency — primary pattern for "fetch all lots from MAC.BID
-- --     updated in the last 24h" (incremental scrape refresh queries).
-- CREATE INDEX IF NOT EXISTS competitor_lots_source_seen_idx
--   ON competitor_lots (source, last_seen_at DESC);

-- -- (2) GIN trigram on title — fuzzy keyword search across all lots.
-- --     Partial index prefers active + confirmed-sold lots; skips closed
-- --     lots with no final bid (abandoned/unsold with no price signal).
-- --     Requires pg_trgm (installed above).
-- CREATE INDEX IF NOT EXISTS competitor_lots_title_trgm_idx
--   ON competitor_lots USING GIN (title gin_trgm_ops)
--   WHERE final_bid_cents IS NOT NULL OR closes_at IS NULL OR closes_at > now() - interval '7 days';

-- -- (3) Brand — filtered partial index; NULL brands are common (scraper not
-- --     yet fine-tuned), exclude them so the index stays small.
-- CREATE INDEX IF NOT EXISTS competitor_lots_brand_idx
--   ON competitor_lots (brand)
--   WHERE brand IS NOT NULL;

-- -- (4) Sold comps — closes_at + final_bid for "what did condition X sell for
-- --     in the last 90d" price-comp queries.
-- CREATE INDEX IF NOT EXISTS competitor_lots_sold_comps_idx
--   ON competitor_lots (closes_at)
--   WHERE final_bid_cents IS NOT NULL;

-- -- (5) Category — joins to categories table for category-level analytics.
-- CREATE INDEX IF NOT EXISTS competitor_lots_category_idx
--   ON competitor_lots (category_id)
--   WHERE category_id IS NOT NULL;

-- -- (6) UPC — joins to product_lookups for enrichment / de-dup.
-- --     Partial index excludes NULL upcs (majority of rows until scraper
-- --     improves brand/upc extraction).
-- CREATE INDEX IF NOT EXISTS competitor_lots_upc_idx
--   ON competitor_lots (upc)
--   WHERE upc IS NOT NULL;
