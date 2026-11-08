-- ============================================================================
-- Global category taxonomy.
--
-- One platform-owned tree (Home Improvement → Power Tools, etc) that all
-- operators classify lots into. Cross-operator browse needs a single
-- canonical pivot — bidders shop by what they want to buy, not by who's
-- selling it. Operators can't invent new categories in v1; they can
-- only influence which raw retailer string maps where via the
-- category_aliases table.
--
-- Two new tables:
--   categories         — the tree (1-2 levels: parent + leaf).
--   category_aliases   — raw retailer strings → category_id mappings.
--                        Populated by LotTR (the planned import tool)
--                        and operators correcting mis-classifications.
--
-- One column added to lots:
--   category_id UUID NULL — the canonical category. NULL means
--                           unclassified (treat as 'other-misc' in the
--                           bidder browse). Raw retailer string stays
--                           in the existing lots.category column for
--                           debugging + manual fixes.
--
-- Index strategy: composite (category_id, status, close_at) on the
-- subset of biddable statuses — that's the "bidder narrows browse to
-- a category" query pattern, sorted by ending-soon. Avoids loading
-- closed/won lots into the index pages.
-- ============================================================================

CREATE TABLE IF NOT EXISTS categories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  parent_id   UUID REFERENCES categories(id) ON DELETE SET NULL,
  icon        TEXT,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS categories_parent_idx ON categories (parent_id);
CREATE INDEX IF NOT EXISTS categories_sort_idx ON categories (sort_order, name);

CREATE TABLE IF NOT EXISTS category_aliases (
  raw           TEXT PRIMARY KEY,                          -- normalized: trimmed, lowercased
  category_id   UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  source        TEXT,                                      -- 'lottr-llm' / 'manual' / 'rule:keyword' / 'seed'
  confidence    REAL,                                      -- 0-1, optional
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lots_category_browse_idx
  ON lots (category_id, status, close_at)
  WHERE status IN ('scheduled', 'live');

-- ----------------------------------------------------------------------------
-- RLS — categories and category_aliases are public read for any
-- authenticated bidder. Writes are platform-admin only (no policy
-- means RLS denies; service role bypasses for migrations + LotTR).
-- ----------------------------------------------------------------------------

ALTER TABLE categories       ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS categories_public_read ON categories;
DROP POLICY IF EXISTS category_aliases_public_read ON category_aliases;

CREATE POLICY categories_public_read ON categories
  FOR SELECT USING (true);

CREATE POLICY category_aliases_public_read ON category_aliases
  FOR SELECT USING (true);

-- ----------------------------------------------------------------------------
-- Seed: 14 top-level categories + ~50 leaves. Slugs are stable so the
-- bidder app and LotTR can hardcode references without storing UUIDs.
-- ----------------------------------------------------------------------------

INSERT INTO categories (slug, name, icon, sort_order) VALUES
  ('home-improvement', 'Home Improvement',  '🔧',  1),
  ('outdoor-garden',   'Outdoor & Garden',  '🌿',  2),
  ('kitchen-dining',   'Kitchen & Dining',  '🍳',  3),
  ('bath',             'Bath',              '🛁',  4),
  ('electronics',      'Electronics',       '📱',  5),
  ('furniture',        'Furniture',         '🛋️',  6),
  ('apparel',          'Apparel & Shoes',   '👕',  7),
  ('auto',             'Auto & Powersports','🚗',  8),
  ('beauty',           'Beauty & Personal', '💄',  9),
  ('health',           'Health & Wellness', '💊', 10),
  ('toys-games',       'Toys & Games',      '🎮', 11),
  ('sports-fitness',   'Sports & Fitness',  '⚽', 12),
  ('baby-kids',        'Baby & Kids',       '🧸', 13),
  ('pet-supplies',     'Pet Supplies',      '🐾', 14),
  ('office-school',    'Office & School',   '📎', 15),
  ('other-misc',       'Other',             '📦', 99)
ON CONFLICT (slug) DO NOTHING;

-- Helper function for cleaner child inserts (private to this migration).
DO $$
DECLARE
  v_home UUID := (SELECT id FROM categories WHERE slug='home-improvement');
  v_outdoor UUID := (SELECT id FROM categories WHERE slug='outdoor-garden');
  v_kitchen UUID := (SELECT id FROM categories WHERE slug='kitchen-dining');
  v_bath UUID := (SELECT id FROM categories WHERE slug='bath');
  v_electronics UUID := (SELECT id FROM categories WHERE slug='electronics');
  v_furniture UUID := (SELECT id FROM categories WHERE slug='furniture');
  v_apparel UUID := (SELECT id FROM categories WHERE slug='apparel');
  v_auto UUID := (SELECT id FROM categories WHERE slug='auto');
  v_sports UUID := (SELECT id FROM categories WHERE slug='sports-fitness');
  v_toys UUID := (SELECT id FROM categories WHERE slug='toys-games');
BEGIN
  INSERT INTO categories (slug, name, parent_id, sort_order) VALUES
    -- Home Improvement
    ('power-tools',       'Power Tools',        v_home, 1),
    ('hand-tools',        'Hand Tools',         v_home, 2),
    ('hardware',          'Hardware & Fasteners', v_home, 3),
    ('plumbing',          'Plumbing',           v_home, 4),
    ('electrical',        'Electrical',         v_home, 5),
    ('paint-decor',       'Paint & Decor',      v_home, 6),
    ('lighting',          'Lighting',           v_home, 7),
    ('storage-organization', 'Storage & Organization', v_home, 8),
    ('hvac',              'HVAC & Air Quality', v_home, 9),
    ('flooring',          'Flooring & Tile',    v_home, 10),

    -- Outdoor & Garden
    ('lawn-care',         'Lawn Care',          v_outdoor, 1),
    ('garden-tools',      'Garden Tools',       v_outdoor, 2),
    ('grills-cooking',    'Grills & Outdoor Cooking', v_outdoor, 3),
    ('patio-furniture',   'Patio Furniture',    v_outdoor, 4),
    ('outdoor-power',     'Outdoor Power Equipment', v_outdoor, 5),
    ('garden-plants',     'Plants & Soil',      v_outdoor, 6),

    -- Kitchen
    ('small-appliances',  'Small Appliances',   v_kitchen, 1),
    ('major-appliances',  'Major Appliances',   v_kitchen, 2),
    ('cookware',          'Cookware',           v_kitchen, 3),
    ('dinnerware',        'Dinnerware & Glassware', v_kitchen, 4),
    ('kitchen-gadgets',   'Kitchen Gadgets',    v_kitchen, 5),
    ('food-pantry',       'Food & Pantry',      v_kitchen, 6),

    -- Bath
    ('vanities',          'Vanities',           v_bath, 1),
    ('faucets-fixtures',  'Faucets & Fixtures', v_bath, 2),
    ('showers-tubs',      'Showers & Tubs',     v_bath, 3),
    ('bath-hardware',     'Bath Hardware',      v_bath, 4),

    -- Electronics
    ('tvs',               'TVs',                v_electronics, 1),
    ('audio',             'Audio',              v_electronics, 2),
    ('computers',         'Computers',          v_electronics, 3),
    ('gaming',            'Gaming',             v_electronics, 4),
    ('smart-home',        'Smart Home',         v_electronics, 5),
    ('cameras',           'Cameras',            v_electronics, 6),

    -- Furniture
    ('living-room',       'Living Room',        v_furniture, 1),
    ('bedroom',           'Bedroom',            v_furniture, 2),
    ('office-furniture',  'Office Furniture',   v_furniture, 3),
    ('dining-furniture',  'Dining Furniture',   v_furniture, 4),

    -- Apparel
    ('mens',              'Men''s',             v_apparel, 1),
    ('womens',            'Women''s',           v_apparel, 2),
    ('kids-apparel',      'Kids''',             v_apparel, 3),
    ('shoes',             'Shoes',              v_apparel, 4),
    ('accessories',       'Accessories',        v_apparel, 5),

    -- Auto
    ('auto-parts',        'Parts',              v_auto, 1),
    ('auto-accessories',  'Accessories',        v_auto, 2),
    ('tires-wheels',      'Tires & Wheels',     v_auto, 3),
    ('auto-tools',        'Auto Tools',         v_auto, 4),

    -- Sports
    ('exercise',          'Exercise Equipment', v_sports, 1),
    ('outdoor-sports',    'Outdoor Sports',     v_sports, 2),
    ('cycling',           'Cycling',            v_sports, 3),

    -- Toys
    ('toys-figures',      'Toys & Figures',     v_toys, 1),
    ('board-games',       'Board Games & Puzzles', v_toys, 2),
    ('outdoor-toys',      'Outdoor Toys',       v_toys, 3)
  ON CONFLICT (slug) DO NOTHING;
END $$;

-- ----------------------------------------------------------------------------
-- Seed aliases — keyword rules tuned to common Lowes / Wayfair retailer
-- category strings. LotTR will populate this with LLM-classified entries
-- as it processes more manifests; these are the floor.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('landscape lighting',      'lighting'),
      ('specialty closet doors',  'storage-organization'),
      ('battery hedge trimmer',   'lawn-care'),
      ('tubular drains',          'plumbing'),
      ('cleaning tools',          'kitchen-gadgets'),
      ('mower accessories',       'lawn-care'),
      ('bath fans',               'bath-hardware'),
      ('lawn and garden tools',   'garden-tools'),
      ('lawn mowers',             'lawn-care'),
      ('bagger',                  'lawn-care'),
      ('mower',                   'lawn-care'),
      ('vanity',                  'vanities'),
      ('vanities',                'vanities'),
      ('faucet',                  'faucets-fixtures'),
      ('shower',                  'showers-tubs'),
      ('toilet',                  'plumbing'),
      ('drill',                   'power-tools'),
      ('saw',                     'power-tools'),
      ('grinder',                 'power-tools'),
      ('hand tool',               'hand-tools'),
      ('screw',                   'hardware'),
      ('hardware',                'hardware'),
      ('plumbing',                'plumbing'),
      ('electrical',              'electrical'),
      ('paint',                   'paint-decor'),
      ('light',                   'lighting'),
      ('bulb',                    'lighting'),
      ('hvac',                    'hvac'),
      ('air filter',              'hvac'),
      ('flooring',                'flooring'),
      ('tile',                    'flooring'),
      ('grill',                   'grills-cooking'),
      ('patio',                   'patio-furniture'),
      ('snow blower',             'outdoor-power'),
      ('generator',               'outdoor-power'),
      ('refrigerator',            'major-appliances'),
      ('washer',                  'major-appliances'),
      ('dryer',                   'major-appliances'),
      ('microwave',               'small-appliances'),
      ('blender',                 'small-appliances'),
      ('cookware',                'cookware'),
      ('television',              'tvs'),
      ('headphones',              'audio'),
      ('laptop',                  'computers'),
      ('tablet',                  'computers'),
      ('console',                 'gaming'),
      ('camera',                  'cameras'),
      ('sofa',                    'living-room'),
      ('couch',                   'living-room'),
      ('mattress',                'bedroom'),
      ('desk',                    'office-furniture'),
      ('dining table',            'dining-furniture'),
      ('treadmill',               'exercise'),
      ('bicycle',                 'cycling'),
      ('bike',                    'cycling')
    ) AS t(raw, slug)
  LOOP
    INSERT INTO category_aliases (raw, category_id, source, confidence)
    SELECT r.raw, c.id, 'seed:keyword', 0.7
    FROM categories c
    WHERE c.slug = r.slug
    ON CONFLICT (raw) DO NOTHING;
  END LOOP;
END $$;
