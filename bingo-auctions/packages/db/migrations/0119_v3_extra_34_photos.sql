-- ============================================================================
-- 0119_v3_extra_34_photos.sql
--
-- Populates v3 image URLs for the 34 categories the original v3 pack didn't
-- ship for. The additional-categories pack (clovrbid_additional_categories_
-- photo_real_pack.zip) uploaded 340 new files under the existing /v3/ prefix
-- in R2. This migration points the corresponding DB rows at them.
--
-- All 34 slugs in this migration have already been verified to return HTTP
-- 200 on cdn.clovrbid.com (sample probes: cookware, lighting, toys-figures,
-- camping, pest-control). Idempotent: WHERE image_url IS NULL guards re-runs.
-- ============================================================================

WITH extra_slugs(slug) AS (
  VALUES
    ('appliance-parts'),
    ('arts-crafts'),
    ('auto-accessories'),
    ('board-games'),
    ('boating-water'),
    ('building-materials'),
    ('camping'),
    ('cell-phones'),
    ('cleaning-supplies'),
    ('computers'),
    ('cookware'),
    ('costumes'),
    ('dinnerware'),
    ('doors-windows'),
    ('fire-pits'),
    ('garden-plants'),
    ('garden-tools'),
    ('industrial-business'),
    ('kids-furniture'),
    ('kitchen-gadgets'),
    ('laundry-appliances'),
    ('lighting'),
    ('luggage-travel'),
    ('major-appliances'),
    ('outdoor-toys'),
    ('party-seasonal'),
    ('pest-control'),
    ('pool-spa'),
    ('rugs-mats'),
    ('scooters-rideons'),
    ('tires-wheels'),
    ('toys-figures'),
    ('wearable-tech'),
    ('window-treatments')
)
UPDATE categories c SET
  image_url       = 'https://cdn.clovrbid.com/v3/01_DROP_IN_CATEGORY_CARDS/800x600/' || c.slug || '.webp',
  image_url_clean = 'https://cdn.clovrbid.com/v3/02_NO_TEXT_PHOTOS/800x600/'        || c.slug || '.webp',
  square_url      = 'https://cdn.clovrbid.com/v3/03_SQUARE_TILES/800x800/'          || c.slug || '.webp',
  pack_slug       = c.slug
FROM extra_slugs e
WHERE c.slug = e.slug
  AND c.image_url IS NULL;
