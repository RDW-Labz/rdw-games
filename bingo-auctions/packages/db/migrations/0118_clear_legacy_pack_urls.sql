-- ============================================================================
-- 0118_clear_legacy_pack_urls.sql
--
-- After migrations 0116 + 0117, 64 of 98 categories now point at the v3
-- pack URLs (cdn.clovrbid.com/v3/...). The remaining 34 split into:
--
--   • 13 categories still pointing at LEGACY v1 / v2 URLs:
--       cdn.clovrbid.com/02_CATEGORY_CARDS/...        (v1 illustrated)
--       cdn.clovrbid.com/02_category_cards_exact_labels/... (v2 missing-pack)
--     These will 404 once the R2 cleanup script deletes the legacy folders.
--
--   • 21 categories with NULL image_url (never matched a pack slug).
--     Already fall back to the placeholder — fine.
--
-- This migration NULLs out the 13 legacy URLs so the homepage / category
-- pages fall back to the v3 photo placeholder. Operators can override
-- per-category in /settings/policies later, or a future pack drop fills
-- the remaining slugs.
--
-- Idempotent: only touches rows where image_url is NOT NULL AND not /v3/.
-- ============================================================================

UPDATE categories SET
  image_url       = NULL,
  image_url_clean = NULL,
  square_url      = NULL,
  pack_slug       = NULL
WHERE image_url IS NOT NULL
  AND image_url NOT LIKE '%/v3/%';
