-- =============================================================================
-- Migration 0132 — Audit index hygiene (2026-05-24)
-- Fixes:  B5/DB-1  competitor_lots (6 post-load indexes were commented out)
--         DB-2     category_aliases (category_id FK + functional length index)
-- =============================================================================
-- NOTE: These are plain CREATE INDEX IF NOT EXISTS (not CONCURRENTLY) because
-- Supabase migrations run inside a transaction and CONCURRENTLY is disallowed
-- inside a transaction block.  On a live table the lock window is brief
-- (milliseconds to low seconds at 295k rows) but ops should plan for it.
-- At 5MM rows, schedule a maintenance window or apply with CONCURRENTLY via
-- psql outside a transaction after verifying no active writes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Part A — competitor_lots (B5/DB-1)
-- Source: packages/db/migrations/0037_competitor_lots.sql:159-195
-- -----------------------------------------------------------------------------

-- (1) Source + recency — primary pattern for incremental scrape refresh queries.
CREATE INDEX IF NOT EXISTS competitor_lots_source_seen_idx
  ON competitor_lots (source, last_seen_at DESC);

-- (2) GIN trigram on title — fuzzy keyword search.
--     Originally drafted with a `now() - interval '7 days'` partial-index
--     predicate to skip abandoned old lots, but Postgres rejects non-IMMUTABLE
--     functions in index predicates ("functions in index predicate must be
--     marked IMMUTABLE"). Full-table GIN is fine at 295k rows and acceptable
--     at 5M — index size is the tradeoff. If size becomes an issue later, swap
--     to a partial index keyed on a boolean column (e.g. `is_recent`)
--     maintained by a trigger or scheduled job.
--     Requires pg_trgm extension (installed in 0037).
CREATE INDEX IF NOT EXISTS competitor_lots_title_trgm_idx
  ON competitor_lots USING GIN (title gin_trgm_ops);

-- (3) Brand — partial index excludes NULL brands to keep the index compact.
CREATE INDEX IF NOT EXISTS competitor_lots_brand_idx
  ON competitor_lots (brand)
  WHERE brand IS NOT NULL;

-- (4) Sold comps — closes_at + final_bid for price-comp queries ("what did X sell
--     for in the last 90d?").
CREATE INDEX IF NOT EXISTS competitor_lots_sold_comps_idx
  ON competitor_lots (closes_at)
  WHERE final_bid_cents IS NOT NULL;

-- (5) Category — joins to categories table for category-level analytics.
CREATE INDEX IF NOT EXISTS competitor_lots_category_idx
  ON competitor_lots (category_id)
  WHERE category_id IS NOT NULL;

-- (6) UPC — joins to product_lookups for enrichment / de-dup.
--     Partial index excludes NULL upcs (majority of rows until scraper improves).
CREATE INDEX IF NOT EXISTS competitor_lots_upc_idx
  ON competitor_lots (upc)
  WHERE upc IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Part B — category_aliases (DB-2)
-- Source: packages/db/migrations/0018_categories.sql:42-48
-- -----------------------------------------------------------------------------

-- FK column — resolver joins category_aliases to categories on this column.
CREATE INDEX IF NOT EXISTS category_aliases_category_id_idx
  ON category_aliases (category_id);

-- Functional index matching resolver sort: ORDER BY LENGTH(raw) DESC
-- Covers the uncovered sort that was forcing a full table scan.
CREATE INDEX IF NOT EXISTS category_aliases_raw_len_idx
  ON category_aliases (length(raw) DESC);
