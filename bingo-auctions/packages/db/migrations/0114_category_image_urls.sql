-- ============================================================================
-- 0114_category_image_urls.sql
--
-- Extends the categories table with CDN imagery from the ClovrBid asset pack
-- and inserts new leaf nodes identified during taxonomy mapping.
--
-- Safe to re-run:
--   • ADD COLUMN IF NOT EXISTS guards column additions.
--   • INSERT ... ON CONFLICT (slug) DO NOTHING skips existing rows.
--   • UPDATE ... WHERE pack_slug IS NULL prevents overwriting manual edits.
--
-- Asset pack base URL: https://cdn.clovrbid.com/
-- Mapping source:      packages/db/data/category_pack_mapping.json (version 1)
-- Pack taxonomy:       /tmp/clovrbid-pack/.../08_DATA/clovrbid_category_taxonomy.csv (66 slugs)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Add columns
-- ----------------------------------------------------------------------------

ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS image_url  TEXT NULL,
  ADD COLUMN IF NOT EXISTS icon_url   TEXT NULL,
  ADD COLUMN IF NOT EXISTS pack_slug  TEXT NULL;

COMMENT ON COLUMN categories.image_url IS
  'CDN URL for the 800x600 webp category card sourced from the ClovrBid asset pack. '
  'Pattern: https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/{pack_slug}-category-card-800x600.webp. '
  'NULL means no pack asset assigned; UI falls back to a default placeholder image.';

COMMENT ON COLUMN categories.icon_url IS
  'CDN URL for the 512px PNG category icon sourced from the ClovrBid asset pack. '
  'Pattern: https://cdn.clovrbid.com/05_CATEGORY_ICONS/{pack_slug}-icon-512.png. '
  'NULL means no pack asset assigned; UI falls back to a default placeholder icon.';

COMMENT ON COLUMN categories.pack_slug IS
  'The slug from the ClovrBid asset pack (clovrbid_category_taxonomy.csv) whose imagery '
  'is used for this category. Stored so the seeding query is idempotent and so downstream '
  'tooling can derive square/thumb variants: '
  '  square  → https://cdn.clovrbid.com/02_CATEGORY_CARDS/square_1080/{pack_slug}-category-card-1080.webp '
  '  thumb   → https://cdn.clovrbid.com/02_CATEGORY_CARDS/thumb_400x300/{pack_slug}-category-card-400x300.jpg';

-- ----------------------------------------------------------------------------
-- 2. New leaf nodes identified during mapping
--    (pack slugs with no existing DB home — see new_leaves_needed in mapping JSON)
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_electronics UUID := (SELECT id FROM categories WHERE slug = 'electronics');
  v_other       UUID := (SELECT id FROM categories WHERE slug = 'other-misc');
  v_home        UUID := (SELECT id FROM categories WHERE slug = 'home-improvement');
BEGIN
  INSERT INTO categories (slug, name, parent_id, sort_order) VALUES
    -- electronics children
    ('remote-controls',         'Remote Controls',             v_electronics, 7),
    ('batteries-accessories',   'Batteries & Accessories',     v_electronics, 8),
    -- other-misc children
    ('books-media',             'Books & Media',               v_other,       1),
    ('collectibles',            'Collectibles & Coins',        v_other,       2),
    -- home-improvement child
    ('flashlights-portable-lighting', 'Flashlights & Portable Lighting', v_home, 11)
  ON CONFLICT (slug) DO NOTHING;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Set image_url / icon_url / pack_slug on every category that has a pack
--    mapping. Condition WHERE pack_slug IS NULL makes it safe to re-run
--    without overwriting any manually-set values.
--
--    Parent-level rows are included so the homepage 4-up grid can pull imagery
--    without a separate query.
-- ----------------------------------------------------------------------------

UPDATE categories SET
  pack_slug = 'tools-hardware',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/tools-hardware-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/tools-hardware-icon-512.png'
WHERE slug = 'home-improvement' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'lawn-garden',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/lawn-garden-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/lawn-garden-icon-512.png'
WHERE slug = 'outdoor-garden' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'kitchen-dining',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/kitchen-dining-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/kitchen-dining-icon-512.png'
WHERE slug = 'kitchen-dining' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'electronics',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/electronics-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/electronics-icon-512.png'
WHERE slug = 'electronics' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'furniture',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/furniture-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/furniture-icon-512.png'
WHERE slug = 'furniture' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'clothing-shoes',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/clothing-shoes-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/clothing-shoes-icon-512.png'
WHERE slug = 'apparel' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'automotive',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/automotive-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/automotive-icon-512.png'
WHERE slug = 'auto' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'health-beauty',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/health-beauty-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/health-beauty-icon-512.png'
WHERE slug IN ('beauty', 'health') AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'toys-games',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/toys-games-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/toys-games-icon-512.png'
WHERE slug = 'toys-games' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'sports-fitness',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/sports-fitness-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/sports-fitness-icon-512.png'
WHERE slug = 'sports-fitness' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'baby-toddler',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/baby-toddler-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/baby-toddler-icon-512.png'
WHERE slug = 'baby-kids' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'pet-supplies',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/pet-supplies-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/pet-supplies-icon-512.png'
WHERE slug = 'pet-supplies' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'office-furniture',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/office-furniture-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/office-furniture-icon-512.png'
WHERE slug = 'office-school' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'general-merchandise',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/general-merchandise-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/general-merchandise-icon-512.png'
WHERE slug = 'other-misc' AND pack_slug IS NULL;

-- home-improvement leaves
UPDATE categories SET
  pack_slug = 'tool-sets',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/tool-sets-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/tool-sets-icon-512.png'
WHERE slug = 'power-tools' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'tools-hardware',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/tools-hardware-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/tools-hardware-icon-512.png'
WHERE slug IN ('hand-tools', 'hardware') AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'lighting-electrical',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/lighting-electrical-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/lighting-electrical-icon-512.png'
WHERE slug IN ('electrical', 'lighting') AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'storage-organization',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/storage-organization-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/storage-organization-icon-512.png'
WHERE slug = 'storage-organization' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'home-decor',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/home-decor-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/home-decor-icon-512.png'
WHERE slug = 'paint-decor' AND pack_slug IS NULL;

-- outdoor-garden leaves
UPDATE categories SET
  pack_slug = 'lawn-garden',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/lawn-garden-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/lawn-garden-icon-512.png'
WHERE slug IN ('lawn-care', 'garden-tools', 'outdoor-power', 'garden-plants') AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'patio-outdoor',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/patio-outdoor-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/patio-outdoor-icon-512.png'
WHERE slug IN ('grills-cooking', 'patio-furniture') AND pack_slug IS NULL;

-- kitchen-dining leaves
UPDATE categories SET
  pack_slug = 'air-fryers',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/air-fryers-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/air-fryers-icon-512.png'
WHERE slug = 'small-appliances' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'appliances',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/appliances-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/appliances-icon-512.png'
WHERE slug = 'major-appliances' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'cookware-sets',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/cookware-sets-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/cookware-sets-icon-512.png'
WHERE slug = 'cookware' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'dishware',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/dishware-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/dishware-icon-512.png'
WHERE slug = 'dinnerware' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'kitchen-utensils',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/kitchen-utensils-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/kitchen-utensils-icon-512.png'
WHERE slug = 'kitchen-gadgets' AND pack_slug IS NULL;

-- electronics leaves
UPDATE categories SET
  pack_slug = 'tvs-home-theater',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/tvs-home-theater-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/tvs-home-theater-icon-512.png'
WHERE slug = 'tvs' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'audio',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/audio-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/audio-icon-512.png'
WHERE slug = 'audio' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'computers-tablets',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/computers-tablets-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/computers-tablets-icon-512.png'
WHERE slug = 'computers' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'gaming',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/gaming-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/gaming-icon-512.png'
WHERE slug = 'gaming' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'electronics',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/electronics-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/electronics-icon-512.png'
WHERE slug = 'smart-home' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'photography-video',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/photography-video-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/photography-video-icon-512.png'
WHERE slug = 'cameras' AND pack_slug IS NULL;

-- New electronics leaves inserted above
UPDATE categories SET
  pack_slug = 'remote-controls',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/remote-controls-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/remote-controls-icon-512.png'
WHERE slug = 'remote-controls' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'batteries',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/batteries-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/batteries-icon-512.png'
WHERE slug = 'batteries-accessories' AND pack_slug IS NULL;

-- furniture leaves
UPDATE categories SET
  pack_slug = 'living-room',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/living-room-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/living-room-icon-512.png'
WHERE slug = 'living-room' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'bedroom',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/bedroom-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/bedroom-icon-512.png'
WHERE slug = 'bedroom' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'office-furniture',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/office-furniture-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/office-furniture-icon-512.png'
WHERE slug = 'office-furniture' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'furniture',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/furniture-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/furniture-icon-512.png'
WHERE slug = 'dining-furniture' AND pack_slug IS NULL;

-- apparel leaves
UPDATE categories SET
  pack_slug = 'clothing-shoes',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/clothing-shoes-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/clothing-shoes-icon-512.png'
WHERE slug IN ('mens', 'womens', 'kids-apparel', 'shoes') AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'fashion-accessories',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/fashion-accessories-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/fashion-accessories-icon-512.png'
WHERE slug = 'accessories' AND pack_slug IS NULL;

-- auto leaves
UPDATE categories SET
  pack_slug = 'automotive',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/automotive-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/automotive-icon-512.png'
WHERE slug IN ('auto-parts', 'auto-accessories', 'tires-wheels', 'auto-tools') AND pack_slug IS NULL;

-- sports-fitness leaves
UPDATE categories SET
  pack_slug = 'sports-fitness',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/sports-fitness-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/sports-fitness-icon-512.png'
WHERE slug IN ('exercise', 'outdoor-sports', 'cycling') AND pack_slug IS NULL;

-- toys-games leaves
UPDATE categories SET
  pack_slug = 'toys-games',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/toys-games-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/toys-games-icon-512.png'
WHERE slug IN ('toys-figures', 'board-games', 'outdoor-toys') AND pack_slug IS NULL;

-- other-misc new leaves
UPDATE categories SET
  pack_slug = 'books-media',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/books-media-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/books-media-icon-512.png'
WHERE slug = 'books-media' AND pack_slug IS NULL;

UPDATE categories SET
  pack_slug = 'collectibles-coins',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/collectibles-coins-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/collectibles-coins-icon-512.png'
WHERE slug = 'collectibles' AND pack_slug IS NULL;

-- home-improvement new leaf
UPDATE categories SET
  pack_slug = 'flashlights',
  image_url = 'https://cdn.clovrbid.com/02_CATEGORY_CARDS/webp_800x600/flashlights-category-card-800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/05_CATEGORY_ICONS/flashlights-icon-512.png'
WHERE slug = 'flashlights-portable-lighting' AND pack_slug IS NULL;

-- vacuums → closest DB leaf is small-appliances (floor-care appliances)
-- Already has air-fryers as primary; set vacuums on the parent row for
-- reference only (vacuums is listed as an alternate in category_pack_mapping.json)
-- No separate UPDATE needed — vacuums is captured as an alternate pack slug.
