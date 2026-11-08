-- ============================================================================
-- 0117_v3_slug_renames.sql
--
-- Backfills v3 imagery for DB categories whose slugs don't match v3's
-- naming exactly. Migration 0116 only hit the 31 slugs that line up
-- one-to-one; this fills the gap for parents + leaves where v3 has a
-- semantically-equivalent slug under a different name.
--
-- Idempotent: only updates rows where image_url is NULL or not /v3/.
-- ============================================================================

WITH rename_map(db_slug, v3_slug) AS (
  VALUES
    -- DB parents
    ('apparel',                    'apparel-shoes'),
    ('auto',                       'auto-powersports'),
    ('beauty',                     'beauty-personal'),
    ('health',                     'health-wellness'),
    ('other-misc',                 'general-merchandise'),
    ('bath',                       'bath-hardware'),
    -- apparel leaves
    ('mens',                       'apparel-shoes'),
    ('womens',                     'apparel-shoes'),
    ('kids-apparel',               'apparel-shoes'),
    ('shoes',                      'apparel-shoes'),
    ('accessories',                'fashion-accessories'),
    -- auto leaves
    ('auto-parts',                 'auto-powersports'),
    ('tires',                      'auto-powersports'),
    ('auto-tools',                 'tool-sets'),
    -- beauty leaves
    ('makeup',                     'beauty-personal'),
    ('skincare',                   'beauty-personal'),
    ('haircare',                   'beauty-personal'),
    ('fragrance',                  'beauty-personal'),
    -- health leaves
    ('supplements',                'health-wellness'),
    ('medical',                    'health-wellness'),
    ('personal-care',              'health-wellness'),
    ('fitness-wellness',           'health-wellness'),
    -- kitchen-dining leaves
    ('small-appliances',           'kitchen-appliances'),
    ('cookware-bakeware',          'cookware-sets'),
    ('dinnerware-flatware',        'dishware'),
    -- furniture leaves
    ('dining-furniture',           'furniture'),
    ('mattresses',                 'bedroom'),
    -- sports-fitness leaves
    ('exercise',                   'sports-fitness'),
    ('outdoor-sports',             'sports-fitness'),
    ('cycling',                    'sports-fitness'),
    -- electronics leaves
    ('tvs',                        'tvs-home-theater'),
    ('cameras',                    'photography-video'),
    ('smart-home',                 'electronics'),
    ('batteries-accessories',      'batteries'),
    -- home-improvement leaves
    ('power-tools',                'tool-sets'),
    ('hand-tools',                 'tool-sets'),
    ('hardware',                   'tools-hardware'),
    ('paint-decor',                'home-decor'),
    ('electrical',                 'lighting-electrical'),
    ('flashlights-portable-lighting', 'flashlights'),
    -- outdoor leaves
    ('lawn-care',                  'lawn-garden'),
    ('grills-cooking',             'patio-outdoor'),
    ('patio-furniture',            'patio-outdoor'),
    ('outdoor-power',              'lawn-garden'),
    -- office-school leaves
    ('school-supplies',            'office-school'),
    ('office-supplies',            'office-school'),
    -- other-misc leaves
    ('collectibles',               'collectibles-coins'),
    ('crafts-hobbies',             'general-merchandise')
)
UPDATE categories c SET
  image_url       = 'https://cdn.clovrbid.com/v3/01_DROP_IN_CATEGORY_CARDS/800x600/' || r.v3_slug || '.webp',
  image_url_clean = 'https://cdn.clovrbid.com/v3/02_NO_TEXT_PHOTOS/800x600/'        || r.v3_slug || '.webp',
  square_url      = 'https://cdn.clovrbid.com/v3/03_SQUARE_TILES/800x800/'          || r.v3_slug || '.webp',
  pack_slug       = r.v3_slug
FROM rename_map r
WHERE c.slug = r.db_slug
  AND (c.image_url IS NULL OR c.image_url NOT LIKE '%/v3/%');
