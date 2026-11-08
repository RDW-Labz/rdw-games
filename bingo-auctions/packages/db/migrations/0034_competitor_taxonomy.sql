-- ============================================================================
-- Phase 6: canonical taxonomy expansion based on competitor research.
--
-- Researched against:
--   - BidFTA            (https://www.bidfta.com/category/all/1)
--   - MAC.BID           (https://www.mac.bid/)
--   - Nellis Auction    (https://www.nellisauction.com/)
--
-- Key structural fix:
--
--   `appliances` becomes a top-level. Both BidFTA and MAC.BID surface
--   "Appliances" as a peer to Furniture / Home Improvement. Nellis
--   bundles into "Furniture & Appliances" but with sub-cats. Our prior
--   tree had `major-appliances` and `small-appliances` nested under
--   `kitchen-dining` — washers and refrigerators don't belong under
--   "Kitchen & Dining" from a bidder mental model. Re-parenting fixes
--   the single biggest navigation defect in the tree.
--
-- 15 new leaves across the existing top-levels (cell-phones,
-- wearable-tech, building-materials, doors-windows, pool-spa, fire-pits,
-- pest-control, camping, scooters-rideons, boating-water, costumes,
-- laundry, kids-furniture, collectibles, musical-instruments, plus
-- laundry-appliances + appliance-parts under the new top-level).
--
-- ~50 new aliases mapping competitor labels (e.g. "Furniture & Appliances",
-- "Cell Phones, Chargers & Accessories", "Pool Supplies", "Costumes &
-- Accessories") to the canonical slugs.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. New top-level: appliances.
-- ----------------------------------------------------------------------------

INSERT INTO categories (slug, name, icon, sort_order) VALUES
  ('appliances', 'Appliances', '🧺', 17)
ON CONFLICT (slug) DO NOTHING;

-- Re-parent: major + small appliances move from kitchen-dining → appliances.
UPDATE categories
   SET parent_id = (SELECT id FROM categories WHERE slug = 'appliances'),
       sort_order = CASE
         WHEN slug = 'major-appliances' THEN 1
         WHEN slug = 'small-appliances' THEN 2
         ELSE sort_order
       END
 WHERE slug IN ('major-appliances', 'small-appliances');

-- ----------------------------------------------------------------------------
-- B. New leaves under existing + new top-levels.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_appliances UUID := (SELECT id FROM categories WHERE slug='appliances');
  v_electronics UUID := (SELECT id FROM categories WHERE slug='electronics');
  v_home UUID := (SELECT id FROM categories WHERE slug='home-improvement');
  v_outdoor UUID := (SELECT id FROM categories WHERE slug='outdoor-garden');
  v_sports UUID := (SELECT id FROM categories WHERE slug='sports-fitness');
  v_apparel UUID := (SELECT id FROM categories WHERE slug='apparel');
  v_bath UUID := (SELECT id FROM categories WHERE slug='bath');
  v_furniture UUID := (SELECT id FROM categories WHERE slug='furniture');
  v_other UUID := (SELECT id FROM categories WHERE slug='other-misc');
BEGIN
  INSERT INTO categories (slug, name, parent_id, sort_order) VALUES
    -- Under appliances
    ('laundry-appliances',  'Laundry Appliances',         v_appliances,   3),
    ('appliance-parts',     'Appliance Parts',            v_appliances,   4),

    -- Under electronics (the gap on cell phones is real — Nellis treats it as Level 2)
    ('cell-phones',         'Cell Phones & Accessories',  v_electronics,  9),
    ('wearable-tech',       'Wearable Technology',        v_electronics, 10),

    -- Under home-improvement (Nellis Level 2: Building Materials, Doors & Windows)
    ('building-materials',  'Building Materials',         v_home,        11),
    ('doors-windows',       'Doors & Windows',            v_home,        12),

    -- Under outdoor-garden (Nellis: Pool, Fire Pits, Pest Control as distinct sub-cats)
    ('pool-spa',            'Pool & Spa',                 v_outdoor,     11),
    ('fire-pits',           'Fire Pits & Outdoor Heating',v_outdoor,     12),
    ('pest-control',        'Pest Control',               v_outdoor,     13),

    -- Under sports-fitness (covers Nellis "Outdoors & Sports" sub-cats)
    ('camping',             'Camping & Hiking',           v_sports,       4),
    ('scooters-rideons',    'Scooters & Ride-Ons',        v_sports,       5),
    ('boating-water',       'Boating & Water Sports',     v_sports,       6),

    -- Under apparel
    ('costumes',            'Costumes & Dress-Up',        v_apparel,      6),

    -- Under bath (Nellis pairs Bath with Laundry — laundry-care products,
    --             not appliances which live under the new appliances parent)
    ('laundry',             'Laundry Care',               v_bath,         5),

    -- Under furniture
    ('kids-furniture',      'Kids Furniture',             v_furniture,    5),

    -- Under other-misc (collectibles + musical instruments don't fit
    -- cleanly anywhere else; competitors handle them as standalones)
    ('collectibles',        'Collectibles & Fine Art',    v_other,        2),
    ('musical-instruments', 'Musical Instruments',        v_other,        3)
  ON CONFLICT (slug) DO NOTHING;
END $$;

-- ----------------------------------------------------------------------------
-- C. Bulk alias inserts. ~50 new aliases capturing how each competitor
--    labels the same concept. Source-tagged for forensics.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- ===== appliances top-level =====
      ('appliances',                                'appliances',           'seed:0034:bidfta'),
      ('furniture & appliances',                    'appliances',           'seed:0034:nellis'),

      -- ===== laundry-appliances =====
      ('laundry appliances',                        'laundry-appliances',   'seed:0034:nellis'),

      -- ===== appliance-parts =====
      ('appliance parts & accessories',             'appliance-parts',      'seed:0034:nellis'),

      -- ===== cell-phones =====
      ('cell phones, chargers & accessories',       'cell-phones',          'seed:0034:nellis'),
      ('cell phones & accessories',                 'cell-phones',          'seed:0034:nellis'),
      ('gl_mobile_application',                     'cell-phones',          'seed:0034:amazon-gl'),

      -- ===== wearable-tech =====
      ('wearable technology',                       'wearable-tech',        'seed:0034:nellis'),
      ('gl_wireless_accessories',                   'wearable-tech',        'seed:0034:amazon-gl'),

      -- ===== building-materials =====
      ('building materials',                        'building-materials',   'seed:0034:bidfta'),
      ('building materials & ladders',              'building-materials',   'seed:0034:nellis'),

      -- ===== doors-windows =====
      ('doors & windows',                           'doors-windows',        'seed:0034:nellis'),
      ('doors and windows',                         'doors-windows',        'seed:0034:nellis'),

      -- ===== pool-spa =====
      ('pool',                                      'pool-spa',             'seed:0034:nellis'),
      ('pool supplies',                             'pool-spa',             'seed:0034:nellis'),
      ('hot tub',                                   'pool-spa',             'seed:0034:nellis'),

      -- ===== fire-pits =====
      ('fire pits & outdoor heaters',               'fire-pits',            'seed:0034:nellis'),
      ('fire pits',                                 'fire-pits',            'seed:0034:nellis'),

      -- ===== pest-control =====
      ('pest control',                              'pest-control',         'seed:0034:nellis'),

      -- ===== camping =====
      ('camping',                                   'camping',              'seed:0034:nellis'),
      ('camping & hiking',                          'camping',              'seed:0034:nellis'),

      -- ===== scooters-rideons =====
      ('scooters & hoverboards',                    'scooters-rideons',     'seed:0034:nellis'),

      -- ===== boating-water =====
      ('boating',                                   'boating-water',        'seed:0034:nellis'),
      ('boat accessories',                          'boating-water',        'seed:0034:nellis'),
      ('swimming gear',                             'boating-water',        'seed:0034:nellis'),

      -- ===== costumes =====
      ('costumes & accessories',                    'costumes',             'seed:0034:nellis'),
      ('costumes & dress-up',                       'costumes',             'seed:0034:nellis'),

      -- ===== laundry (care products) =====
      -- Note: the bare 'laundry' string is ambiguous. Length-sort means
      -- the more-specific 'laundry appliances' / 'laundry care' aliases
      -- win when present. The bare alias falls back to laundry-care.
      ('laundry care',                              'laundry',              'seed:0034:nellis'),

      -- ===== kids-furniture =====
      ('kids furniture',                            'kids-furniture',       'seed:0034:nellis'),

      -- ===== collectibles =====
      ('collectibles & fine art',                   'collectibles',         'seed:0034:nellis'),
      ('sports collectibles',                       'collectibles',         'seed:0034:nellis'),

      -- ===== musical-instruments =====
      ('musical instruments',                       'musical-instruments',  'seed:0034:bidfta'),
      ('gl_musical_instruments',                    'musical-instruments',  'seed:0034:amazon-gl-fix'),  -- override prior generic mapping

      -- ===== industrial-business expansion =====
      ('food service equipment',                    'industrial-business',  'seed:0034:bidfta'),
      ('top shop food service equipment',           'industrial-business',  'seed:0034:bidfta'),
      ('other equipment',                           'industrial-business',  'seed:0034:bidfta'),

      -- ===== home-decor confirmation =====
      ('home decor',                                'home-decor',           'seed:0034:nellis'),

      -- ===== food-pantry (top-level competitor labels) =====
      ('grocery',                                   'food-pantry',          'seed:0034:bidfta'),
      ('food, supplements & pantry',                'food-pantry',          'seed:0034:nellis'),

      -- ===== smart-home =====
      ('smart home',                                'smart-home',           'seed:0034:nellis'),

      -- ===== arts-crafts =====
      ('arts, crafts & sewing',                     'arts-crafts',          'seed:0034:nellis'),

      -- ===== party-seasonal =====
      ('seasonal & party supplies',                 'party-seasonal',       'seed:0034:nellis'),

      -- ===== cleaning-supplies =====
      ('cleaning supplies',                         'cleaning-supplies',    'seed:0034:nellis'),

      -- ===== window-treatments =====
      ('window treatments',                         'window-treatments',    'seed:0034:nellis'),

      -- ===== rugs-mats =====
      ('rugs',                                      'rugs-mats',            'seed:0034:nellis'),

      -- ===== luggage-travel =====
      ('luggage',                                   'luggage-travel',       'seed:0034:nellis'),

      -- ===== books-media =====
      ('books, music & media',                      'books-media',          'seed:0034:nellis'),
      ('books & media',                             'books-media',          'seed:0034:bidfta'),

      -- ===== jewelry-watches =====
      ('jewelry',                                   'jewelry-watches',      'seed:0034:bidfta'),
      ('luxury',                                    'jewelry-watches',      'seed:0034:nellis'),

      -- ===== auto =====
      ('automotive',                                'auto',                 'seed:0034:bidfta'),

      -- ===== baby-kids =====
      ('baby & toddler',                            'baby-kids',            'seed:0034:macbids'),
      ('baby',                                      'baby-kids',            'seed:0034:nellis'),

      -- ===== office-school =====
      ('office & school supplies',                  'office-school',        'seed:0034:nellis'),
      ('office supplies',                           'office-school',        'seed:0034:bidfta'),

      -- ===== home-improvement =====
      ('tools & home improvement',                  'home-improvement',     'seed:0034:bidfta'),
      ('home improvement',                          'home-improvement',     'seed:0034:macbids'),

      -- ===== outdoor-garden top-level competitor label =====
      ('patio, lawn & garden',                      'outdoor-garden',       'seed:0034:bidfta'),
      ('patio & garden',                            'outdoor-garden',       'seed:0034:nellis'),
      ('home & garden',                             'outdoor-garden',       'seed:0034:macbids'),

      -- ===== sports-fitness top-level competitor labels =====
      ('sports & outdoors',                         'sports-fitness',       'seed:0034:macbids'),
      ('outdoors & sports',                         'sports-fitness',       'seed:0034:nellis'),

      -- ===== electronics =====
      ('electronics',                               'electronics',          'seed:0034:nellis'),

      -- ===== kitchen-dining =====
      ('home & kitchen',                            'kitchen-dining',       'seed:0034:bidfta'),
      ('home & household essentials',               'kitchen-dining',       'seed:0034:nellis'),

      -- ===== beauty top-level (Nellis combines beauty + health) =====
      ('beauty & personal care',                    'beauty',               'seed:0034:nellis'),

      -- ===== pet-supplies =====
      ('pet supplies',                              'pet-supplies',         'seed:0034:macbids')

    ) AS t(raw, slug, source)
  LOOP
    INSERT INTO category_aliases (raw, category_id, source, confidence)
    SELECT r.raw, c.id, r.source, 0.9
    FROM categories c
    WHERE c.slug = r.slug
    ON CONFLICT (raw) DO UPDATE
      SET category_id = EXCLUDED.category_id,
          source      = EXCLUDED.source,
          confidence  = EXCLUDED.confidence;
  END LOOP;
END $$;
