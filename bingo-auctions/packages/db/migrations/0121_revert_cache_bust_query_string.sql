-- ============================================================================
-- 0121_revert_cache_bust_query_string.sql
--
-- Undoes migration 0120. CF edge cache for the 5 affected URLs has been
-- purged via the new CLOUDFLARE_PURGE_TOKEN, so the ?v=2 query-string
-- workaround is no longer needed.
--
-- Strips the trailing ?v=2 from any category URL that has it.
-- ============================================================================

UPDATE categories SET
  image_url       = REGEXP_REPLACE(image_url,       '\?v=\d+$', ''),
  image_url_clean = REGEXP_REPLACE(image_url_clean, '\?v=\d+$', ''),
  square_url      = REGEXP_REPLACE(square_url,      '\?v=\d+$', '')
WHERE image_url       LIKE '%?v=%'
   OR image_url_clean LIKE '%?v=%'
   OR square_url      LIKE '%?v=%';
