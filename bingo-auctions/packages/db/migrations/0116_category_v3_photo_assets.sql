-- ============================================================================
-- 0116_category_v3_photo_assets.sql
--
-- Swap categories.image_url from the v1 illustrated pack to the v3
-- photo-real replacement pack. Adds two new columns:
--
--   image_url_clean TEXT  → 02_NO_TEXT_PHOTOS variant (used where the
--                           frontend renders its own label, e.g. homepage
--                           category grid with overlay text).
--   square_url      TEXT  → 03_SQUARE_TILES variant (used for square
--                           thumbnails in the mega-menu + share cards).
--
-- pack_slug column from migration 0114 is REUSED. For most rows the slug
-- itself is identical between v1 pack-slug and v3 file naming, so the
-- migration uses categories.slug rather than pack_slug as the join key —
-- this aligns better with v3's CSV.
--
-- v3 covers 90 slugs. The remaining ~10 DB leaves that v3 doesn't ship
-- imagery for keep their existing image_url (which may be v1 cartoon or
-- pack 2 photo, depending on which slug). After verify, a future pack
-- drop or manual asset assignment fills those in.
--
-- Idempotent: WHERE image_url NOT LIKE '%/v3/%' prevents re-running
-- against already-migrated rows.
-- ============================================================================

ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS image_url_clean TEXT NULL,
  ADD COLUMN IF NOT EXISTS square_url      TEXT NULL;

COMMENT ON COLUMN categories.image_url_clean IS
  'CDN URL for the 800x600 no-text variant from the v3 photo pack. Used '
  'where the frontend renders its own label overlay (e.g. homepage grid). '
  'NULL = no v3 coverage; fall back to image_url.';

COMMENT ON COLUMN categories.square_url IS
  'CDN URL for the 800x800 square tile from the v3 photo pack. Used in '
  'the mega-menu thumbnails + iOS share cards. NULL = no v3 coverage; '
  'fall back to image_url or a 1:1-cropped placeholder.';

-- ----------------------------------------------------------------------------
-- Bulk update for every DB slug that v3 ships imagery for.
-- The slug list below is the union of v3's category_taxonomy_covered.csv
-- (90 rows) AND the DB's existing slugs — only slugs present in BOTH get
-- updated. Slugs in DB but not in v3 keep their pre-v3 image_url.
-- ----------------------------------------------------------------------------

WITH v3_slugs(slug) AS (
  VALUES
    ('air-fryers'),
    ('apparel-shoes'),
    ('appliances'),
    ('audio'),
    ('auto-powersports'),
    ('automotive'),
    ('baby-kids'),
    ('baby-toddler'),
    ('bakeware'),
    ('bath-hardware'),
    ('batteries'),
    ('beauty-personal'),
    ('bedroom'),
    ('blenders'),
    ('books-media'),
    ('bread-makers'),
    ('clothing-shoes'),
    ('coffee-makers'),
    ('collectibles-coins'),
    ('computers-tablets'),
    ('cookware-sets'),
    ('dishware'),
    ('electric-griddles'),
    ('electric-kettles'),
    ('electronics'),
    ('extension-cords'),
    ('fans'),
    ('fashion-accessories'),
    ('faucets-fixtures'),
    ('flashlights'),
    ('flooring'),
    ('food-pantry'),
    ('food-processors'),
    ('furniture'),
    ('gaming'),
    ('general-merchandise'),
    ('handbags-accessories'),
    ('health-beauty'),
    ('health-wellness'),
    ('home-decor'),
    ('home-goods'),
    ('home-improvement'),
    ('humidifiers'),
    ('hvac'),
    ('ice-makers'),
    ('irons-steamers'),
    ('jewelry-watches'),
    ('kitchen-appliances'),
    ('kitchen-dining'),
    ('kitchen-utensils'),
    ('knife-sets'),
    ('laundry'),
    ('lawn-garden'),
    ('light-bulbs'),
    ('lighting-electrical'),
    ('living-room'),
    ('microwaves'),
    ('musical-instruments'),
    ('office-furniture'),
    ('office-school'),
    ('outdoor-garden'),
    ('patio-outdoor'),
    ('pet-supplies'),
    ('phones-tablets'),
    ('photography-video'),
    ('plumbing'),
    ('pool-recreation'),
    ('power-strips'),
    ('pressure-cookers'),
    ('remote-controls'),
    ('rice-cookers'),
    ('sandwich-makers'),
    ('seasonal-holiday'),
    ('shopping-finds'),
    ('showers-tubs'),
    ('slow-cookers'),
    ('sports-fitness'),
    ('stand-mixers'),
    ('steamers'),
    ('storage-containers'),
    ('storage-organization'),
    ('toasters'),
    ('tool-sets'),
    ('tools-hardware'),
    ('toys-games'),
    ('trash-cans'),
    ('tvs-home-theater'),
    ('vacuums'),
    ('vanities'),
    ('waffle-makers')
)
UPDATE categories c SET
  image_url       = 'https://cdn.clovrbid.com/v3/01_DROP_IN_CATEGORY_CARDS/800x600/' || c.slug || '.webp',
  image_url_clean = 'https://cdn.clovrbid.com/v3/02_NO_TEXT_PHOTOS/800x600/'        || c.slug || '.webp',
  square_url      = 'https://cdn.clovrbid.com/v3/03_SQUARE_TILES/800x800/'          || c.slug || '.webp',
  pack_slug       = c.slug
FROM v3_slugs v
WHERE c.slug = v.slug
  AND (c.image_url IS NULL OR c.image_url NOT LIKE '%/v3/%');

-- Report how many rows touched (informational — no error if 0).
SELECT
  (SELECT COUNT(*) FROM categories WHERE image_url LIKE '%/v3/%') AS v3_mapped,
  (SELECT COUNT(*) FROM categories WHERE image_url IS NULL OR image_url NOT LIKE '%/v3/%') AS legacy_or_unmapped;
