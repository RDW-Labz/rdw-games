-- ============================================================================
-- 0209 — product_lookups semantic embeddings (pgvector).
--
-- Adds an OPTIONAL vector embedding to the catalog so a no-barcode / photo /
-- keyword item can fuzzy-match prior products by MEANING, catching near-dups
-- that the existing pg_trgm title search misses ("cordless drill kit 20v" vs
-- "20-volt cordless drill set"). Trigram stays the first, cheapest pass; the
-- embedding search is a fallback BEFORE we spend a cloud LLM call.
--
-- 768 dims = nomic-embed-text (served locally on the Ollama box, $0/embedding).
-- The column is nullable and everything is additive: with no embeddings
-- populated and the app's embedding provider unconfigured, behavior is
-- identical to today. Backfill happens lazily as catalog rows are upserted.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE product_lookups
  ADD COLUMN IF NOT EXISTS embedding vector(768);

-- ivfflat cosine index. NULL embeddings are simply not indexed; similarity
-- queries filter `embedding IS NOT NULL` anyway. `lists` is a starting point
-- for a small/medium catalog; re-tune after the column is well-populated.
CREATE INDEX IF NOT EXISTS product_lookups_embedding_idx
  ON product_lookups
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Nearest-neighbour search by embedding. Excludes negative-cache rows and
-- applies a cosine-similarity floor so weak matches don't surface. Returns the
-- full product_lookups row shape so the app hydrates it exactly like a trgm or
-- UPC hit.
CREATE OR REPLACE FUNCTION match_products_by_embedding(
  query_embedding vector(768),
  match_threshold float DEFAULT 0.75,
  match_count int DEFAULT 8
)
RETURNS SETOF product_lookups
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM product_lookups
  WHERE embedding IS NOT NULL
    AND confidence <> 'none'
    AND (1 - (embedding <=> query_embedding)) >= match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
