-- ============================================================================
-- Phase 3.6 — product_lookups: the platform's normalized product catalog.
--
-- The cache is the product. Tier 1 lotting (UPC scan / keyword search) reads
-- from this table first; on miss it fetches from external sources (eBay
-- Browse + sold-comps), upserts here, then returns. Over time the hit rate
-- climbs toward 100% and external API calls trend toward zero.
--
-- Scope is GLOBAL — UPC → product is public info, no PII, no competitive
-- leak. One operator scanning a DeWalt drill warms the cache for every
-- operator forever. This is the platform-wide network effect.
--
-- Identity (title/brand/model/image) effectively never goes stale.
-- Prices and sold-comps DO. Refresh strategy is stale-while-revalidate:
-- the lookup module returns the cached row instantly and queues a
-- background refresh if prices_refreshed_at is older than the configured
-- TTL (default 14d). The user never waits.
--
-- Negative results (confidence='none') get cached too with a 7d TTL so
-- we don't re-burn external API quota on dead UPCs — but eventually-
-- cataloged UPCs get a retry chance.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS product_lookups (
  upc                    TEXT PRIMARY KEY,                     -- digits-only normalized
  title                  TEXT,
  brand                  TEXT,
  model                  TEXT,
  category_id            UUID REFERENCES categories(id) ON DELETE SET NULL,
  category_raw           TEXT,                                 -- raw category string from source, for debugging
  image_urls             TEXT[] NOT NULL DEFAULT '{}',

  -- Pricing — all integer cents. Nullable when source returned nothing.
  msrp_cents             BIGINT,
  avg_asking_cents       BIGINT,                               -- avg of current eBay asking-price listings
  median_sold_cents      BIGINT,                               -- eBay 90d sold median — the real auction signal
  start_bid_cents        BIGINT,                               -- derived: median_sold × 0.30 (or fallback)

  -- Raw payloads kept as JSONB for forensics + future schema evolution.
  -- prices: [{retailer, cents, url, fetched_at}]
  -- sold_comps: [{title, cents, sold_at, condition, url}]
  prices                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  sold_comps             JSONB NOT NULL DEFAULT '[]'::jsonb,

  description            TEXT,
  specs                  TEXT,

  -- 'high' | 'medium' | 'low' | 'none'.  'none' = negative-cache row.
  confidence             TEXT NOT NULL DEFAULT 'medium',

  -- Which sources contributed. e.g. ['ebay_browse','ebay_sold'] or ['ai','manual'].
  sources                TEXT[] NOT NULL DEFAULT '{}',

  -- Two timestamps so we can age identity vs prices independently.
  identity_refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  prices_refreshed_at    TIMESTAMPTZ,                          -- null if no prices yet

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE product_lookups IS
  'Platform-global normalized product catalog. Tier 1 lotting reads here first; on miss, fetches from external sources (eBay Browse + sold filter), upserts back. The cache IS the product. UPC→product is public info — global scope is intentional.';

COMMENT ON COLUMN product_lookups.confidence IS
  'high|medium|low|none. "none" = negative-cache row (UPC genuinely not found in any source). Negative rows get a 7d TTL elsewhere.';

COMMENT ON COLUMN product_lookups.median_sold_cents IS
  'eBay 90-day median sold price. This is the authoritative auction-startBid signal — what stuff actually clears at, not MSRP. Prefer this over avg_asking_cents.';

-- ----------------------------------------------------------------------------
-- Indexes — tuned for the three lookup patterns.
--   1. UPC point lookup (PK) — sub-ms
--   2. Keyword fuzzy search on title — pg_trgm GIN
--   3. Brand + model exact-ish match — composite btree
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS product_lookups_title_trgm_idx
  ON product_lookups USING GIN (title gin_trgm_ops)
  WHERE confidence <> 'none';

CREATE INDEX IF NOT EXISTS product_lookups_brand_model_idx
  ON product_lookups (lower(brand), lower(model))
  WHERE brand IS NOT NULL AND model IS NOT NULL AND confidence <> 'none';

CREATE INDEX IF NOT EXISTS product_lookups_category_idx
  ON product_lookups (category_id)
  WHERE category_id IS NOT NULL AND confidence <> 'none';

CREATE INDEX IF NOT EXISTS product_lookups_prices_refresh_idx
  ON product_lookups (prices_refreshed_at)
  WHERE confidence <> 'none';

-- ----------------------------------------------------------------------------
-- Updated_at trigger.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION product_lookups_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_lookups_touch_updated_at ON product_lookups;
CREATE TRIGGER product_lookups_touch_updated_at
  BEFORE UPDATE ON product_lookups
  FOR EACH ROW EXECUTE FUNCTION product_lookups_touch_updated_at();

-- ----------------------------------------------------------------------------
-- RLS — readable by any authed user (bidders + staff alike), writable
-- by operator staff (any role) and the service-role key. The cache is
-- platform-shared so any staff member contributing helps everyone.
-- ----------------------------------------------------------------------------

ALTER TABLE product_lookups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_lookups_authed_read ON product_lookups;
DROP POLICY IF EXISTS product_lookups_staff_write ON product_lookups;

CREATE POLICY product_lookups_authed_read ON product_lookups
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY product_lookups_staff_write ON product_lookups
  FOR ALL
  USING (current_operator_id() IS NOT NULL)
  WITH CHECK (current_operator_id() IS NOT NULL);
