-- ============================================================================
-- 0120_cache_bust_5_fixed_photos.sql
--
-- The 5 misclassified v3 category images (auto-powersports, baby-kids,
-- beauty-personal, health-wellness, pet-supplies) were overwritten on R2
-- with replacement photos. But the R2 objects ship a 1-year immutable
-- Cache-Control header, so the Cloudflare edge cache (and browsers) keep
-- serving the OLD image until the cache expires.
--
-- The Cloudflare cache-purge API requires Zone:Cache Purge scope which
-- the current tokens lack. Workaround: append ?v=2 to the URLs in the DB
-- so browsers + CF edge see a new cache key and fetch fresh.
--
-- Safe future plan: rotate to ?v=3 etc. on any subsequent image swap, OR
-- have the user create a CF token with Cache Purge scope and we'll use
-- proper purge_cache calls instead.
-- ============================================================================

UPDATE categories SET
  image_url       = image_url       || '?v=2',
  image_url_clean = image_url_clean || '?v=2',
  square_url      = square_url      || '?v=2'
WHERE slug IN (
  'auto',
  'auto-powersports',
  'baby-kids',
  'baby-toddler',
  'beauty',
  'beauty-personal',
  'health',
  'health-wellness',
  'pet-supplies'
)
  AND image_url IS NOT NULL
  AND image_url NOT LIKE '%?v=%';
