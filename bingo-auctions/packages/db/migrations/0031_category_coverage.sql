-- ============================================================================
-- Phase 4: massive expansion of category taxonomy + alias table.
--
-- Audit of 7 manifests (~46K rows across Amazon FC returns, BidFTA-template,
-- raw Lowes department, and Wayfair-export-shaped) found that the existing
-- alias seed covers <5% of real-world category strings. The biggest gaps:
--
--   1. Amazon `GLDesc` codes (gl_home, gl_beauty, gl_kitchen, ...) — top 30
--      of these are 80%+ of Amazon return manifests
--   2. BidFTA numeric-prefixed sub-categories ("6400 home decor",
--      "9500 hair care and beauty appliances", ...)
--   3. Lowes department names ("VANITIES", "LANDSCAPE LIGHTING", ...)
--
-- This migration:
--   A. Adds 10 new categories where no existing slug fits (books-media,
--      luggage-travel, home-decor, party-seasonal, industrial-business,
--      arts-crafts, jewelry-watches, window-treatments, rugs-mats,
--      cleaning-supplies)
--   B. Inserts ~200 new alias rows covering the three format families
--
-- Aliases use exact-match (the substring match in resolveCategoryId() will
-- still find longer matches first — that's why we lowercase + trim and
-- store the full retailer string verbatim).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. New categories
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_other UUID := (SELECT id FROM categories WHERE slug='other-misc');
  v_living UUID := (SELECT id FROM categories WHERE slug='living-room');
  v_apparel UUID := (SELECT id FROM categories WHERE slug='apparel');
  v_office UUID := (SELECT id FROM categories WHERE slug='office-school');
  v_paint UUID := (SELECT id FROM categories WHERE slug='paint-decor');
BEGIN
  INSERT INTO categories (slug, name, parent_id, sort_order) VALUES
    ('books-media',       'Books & Media',       v_other,    20),
    ('luggage-travel',    'Luggage & Travel',    v_apparel,  10),
    ('home-decor',        'Home Decor',          v_living,   10),
    ('party-seasonal',    'Party & Seasonal',    v_other,    21),
    ('industrial-business', 'Industrial & Business', v_other, 22),
    ('arts-crafts',       'Arts & Crafts',       v_office,   10),
    ('jewelry-watches',   'Jewelry & Watches',   v_apparel,  11),
    ('window-treatments', 'Window Treatments',   v_paint,    10),
    ('rugs-mats',         'Rugs & Mats',         v_living,   11),
    ('cleaning-supplies', 'Cleaning Supplies',   v_other,    23)
  ON CONFLICT (slug) DO NOTHING;
END $$;

-- ----------------------------------------------------------------------------
-- B. Bulk alias inserts. We group by format family for readability +
-- maintenance. Source label = 'seed:0031:<family>'.
--
-- Note: aliases are matched via lowercase longest-substring in the
-- resolveCategoryId() path (apps/operator-web/src/app/(operator)/imports/
-- actions.ts), so storing the full retailer string verbatim is correct —
-- the substring match handles both exact and embedded matches.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- ===== Amazon GLDesc codes =====
      ('gl_home',                              'living-room',         'seed:0031:amazon-gl'),
      ('gl_kitchen',                           'kitchen-dining',      'seed:0031:amazon-gl'),
      ('gl_beauty',                            'beauty',              'seed:0031:amazon-gl'),
      ('gl_apparel',                           'accessories',         'seed:0031:amazon-gl'),
      ('gl_softlines_private_label',           'apparel',             'seed:0031:amazon-gl'),
      ('gl_toy',                               'toys-games',          'seed:0031:amazon-gl'),
      ('gl_wireless',                          'electronics',         'seed:0031:amazon-gl'),
      ('gl_office_product',                    'office-school',       'seed:0031:amazon-gl'),
      ('gl_drugstore',                         'health',              'seed:0031:amazon-gl'),
      ('gl_grocery',                           'food-pantry',         'seed:0031:amazon-gl'),
      ('gl_home_improvement',                  'home-improvement',    'seed:0031:amazon-gl'),
      ('gl_pet_products',                      'pet-supplies',        'seed:0031:amazon-gl'),
      ('gl_automotive',                        'auto-parts',          'seed:0031:amazon-gl'),
      ('gl_biss',                              'industrial-business', 'seed:0031:amazon-gl'),
      ('gl_book',                              'books-media',         'seed:0031:amazon-gl'),
      ('gl_dvd',                               'books-media',         'seed:0031:amazon-gl'),
      ('gl_music',                             'books-media',         'seed:0031:amazon-gl'),
      ('gl_lawn_and_garden',                   'lawn-care',           'seed:0031:amazon-gl'),
      ('gl_electronics',                       'electronics',         'seed:0031:amazon-gl'),
      ('gl_pc',                                'computers',           'seed:0031:amazon-gl'),
      ('gl_baby_product',                      'baby-kids',           'seed:0031:amazon-gl'),
      ('gl_sports',                            'sports-fitness',      'seed:0031:amazon-gl'),
      ('gl_furniture',                         'furniture',           'seed:0031:amazon-gl'),
      ('gl_outdoors',                          'outdoor-sports',      'seed:0031:amazon-gl'),
      ('gl_camera',                            'cameras',             'seed:0031:amazon-gl'),
      ('gl_shoes',                             'shoes',               'seed:0031:amazon-gl'),
      ('gl_tools',                             'power-tools',         'seed:0031:amazon-gl'),
      ('gl_luggage',                           'luggage-travel',      'seed:0031:amazon-gl'),
      ('gl_major_appliances',                  'major-appliances',    'seed:0031:amazon-gl'),
      ('gl_personal_care_appliances',          'small-appliances',    'seed:0031:amazon-gl'),
      ('gl_home_entertainment',                'tvs',                 'seed:0031:amazon-gl'),
      ('gl_video_games',                       'gaming',              'seed:0031:amazon-gl'),
      ('gl_musical_instruments',               'other-misc',          'seed:0031:amazon-gl'),
      ('gl_watch',                             'jewelry-watches',     'seed:0031:amazon-gl'),
      ('gl_jewelry',                           'jewelry-watches',     'seed:0031:amazon-gl'),
      ('gl_tires',                             'tires-wheels',        'seed:0031:amazon-gl'),
      ('gl_art_craft_supplies',                'arts-crafts',         'seed:0031:amazon-gl'),
      ('gl_digital_accessories',               'electronics',         'seed:0031:amazon-gl'),
      ('gl_software',                          'computers',           'seed:0031:amazon-gl'),
      ('gl_wireless_accessories',              'electronics',         'seed:0031:amazon-gl'),
      ('gl_fc',                                'food-pantry',         'seed:0031:amazon-gl'),

      -- ===== BidFTA Sub-Category (numeric-prefixed) =====
      ('6400 home decor',                      'home-decor',          'seed:0031:bidfta'),
      ('6500 seasonal home decor',             'home-decor',          'seed:0031:bidfta'),
      ('6600 artwork',                         'home-decor',          'seed:0031:bidfta'),
      ('6000 bedding',                         'bedroom',             'seed:0031:bidfta'),
      ('9500 hair care and beauty appliances', 'small-appliances',    'seed:0031:bidfta'),
      ('3500 bath & laundry',                  'bath',                'seed:0031:bidfta'),
      ('13000 hardware',                       'hardware',            'seed:0031:bidfta'),
      ('79000 lighting & fans',                'lighting',            'seed:0031:bidfta'),
      ('80000 electrical & heating',           'electrical',          'seed:0031:bidfta'),
      ('81000 plumbing fixtures',              'faucets-fixtures',    'seed:0031:bidfta'),
      ('83000 rough plumbing',                 'plumbing',            'seed:0031:bidfta'),
      ('89000 light bulbs',                    'lighting',            'seed:0031:bidfta'),
      ('46000 outdoor power',                  'outdoor-power',       'seed:0031:bidfta'),
      ('44000 grilling',                       'grills-cooking',      'seed:0031:bidfta'),
      ('45000 gardening',                      'garden-tools',        'seed:0031:bidfta'),
      ('47000 snow removal',                   'outdoor-power',       'seed:0031:bidfta'),
      ('21000 outdoor furniture',              'patio-furniture',     'seed:0031:bidfta'),
      ('20000 outdoor living',                 'patio-furniture',     'seed:0031:bidfta'),
      ('6054000 flooring',                     'flooring',            'seed:0031:bidfta'),
      ('28000 tool organization & garage storage', 'storage-organization', 'seed:0031:bidfta'),
      ('16000 painting supplies',              'paint-decor',         'seed:0031:bidfta'),
      ('10000 handtools',                      'hand-tools',          'seed:0031:bidfta'),
      ('55000 power tool accessories',         'power-tools',         'seed:0031:bidfta'),
      ('34000 construction - power drills',    'power-tools',         'seed:0031:bidfta'),
      ('37000 generators',                     'outdoor-power',       'seed:0031:bidfta'),
      ('49000 building materials & ladders',   'home-improvement',    'seed:0031:bidfta'),
      ('25000 security & safety',              'smart-home',          'seed:0031:bidfta'),
      ('0100 wireless phones',                 'electronics',         'seed:0031:bidfta'),
      ('0900 wireless cases',                  'electronics',         'seed:0031:bidfta'),
      ('0200 wireless accessories',            'electronics',         'seed:0031:bidfta'),
      ('5300 headphones',                      'audio',               'seed:0031:bidfta'),
      ('5700 cables',                          'electronics',         'seed:0031:bidfta'),
      ('1000 exercise & fitness',              'exercise',            'seed:0031:bidfta'),
      ('9000 cycling',                         'cycling',             'seed:0031:bidfta'),
      ('5000 living room furniture',           'living-room',         'seed:0031:bidfta'),
      ('2000 home office furniture',           'office-furniture',    'seed:0031:bidfta'),
      ('1000 mattresses & mattress frames',    'bedroom',             'seed:0031:bidfta'),
      ('2000 cookware',                        'cookware',            'seed:0031:bidfta'),
      ('1000 bakeware',                        'cookware',            'seed:0031:bidfta'),
      ('3000 tabletop',                        'dinnerware',          'seed:0031:bidfta'),
      ('7200 cooks tools',                     'kitchen-gadgets',     'seed:0031:bidfta'),
      ('4700 cooking appliances',              'small-appliances',    'seed:0031:bidfta'),
      ('5000 mass cosmetics',                  'beauty',              'seed:0031:bidfta'),
      ('8000 novelty/party supplies/costume & dress up', 'party-seasonal', 'seed:0031:bidfta'),
      ('1400 event & party supplies',          'party-seasonal',      'seed:0031:bidfta'),
      ('3000 costume',                         'party-seasonal',      'seed:0031:bidfta'),
      ('31000 professional medical',           'industrial-business', 'seed:0031:bidfta'),
      ('2000 industrial tools & instruments',  'industrial-business', 'seed:0031:bidfta'),
      ('8000 metalworking',                    'industrial-business', 'seed:0031:bidfta'),
      ('3000 lab equipment & instruments',     'industrial-business', 'seed:0031:bidfta'),
      ('8600 arts, crafts and sewing',         'arts-crafts',         'seed:0031:bidfta'),
      ('2500 arts & crafts',                   'arts-crafts',         'seed:0031:bidfta'),
      ('4000 window treatments',               'window-treatments',   'seed:0031:bidfta'),
      ('4000 rugs',                            'rugs-mats',           'seed:0031:bidfta'),
      ('7000 household consumables',           'cleaning-supplies',   'seed:0031:bidfta'),
      ('9100 janitorial & sanitation',         'cleaning-supplies',   'seed:0031:bidfta'),
      ('9700 travel accessories',              'luggage-travel',      'seed:0031:bidfta'),
      ('9100 backpacks',                       'luggage-travel',      'seed:0031:bidfta'),

      -- ===== Lowes department names (raw, ALL-CAPS in source but stored lowercase) =====
      ('vanities',                             'vanities',            'seed:0031:lowes'),
      ('vanity tops',                          'vanities',            'seed:0031:lowes'),
      ('landscape lighting',                   'lighting',            'seed:0031:lowes'),
      ('vanity lighting',                      'lighting',            'seed:0031:lowes'),
      ('outdoor lighting',                     'lighting',            'seed:0031:lowes'),
      ('recessed lighting',                    'lighting',            'seed:0031:lowes'),
      ('commercial lighting',                  'lighting',            'seed:0031:lowes'),
      ('ceiling fans',                         'lighting',            'seed:0031:lowes'),
      ('ceiling fan accessories',              'lighting',            'seed:0031:lowes'),
      ('flushmounts',                          'lighting',            'seed:0031:lowes'),
      ('chandeliers and pendants',             'lighting',            'seed:0031:lowes'),
      ('watering',                             'garden-tools',        'seed:0031:lowes'),
      ('patio furniture',                      'patio-furniture',     'seed:0031:lowes'),
      ('mower accessories',                    'outdoor-power',       'seed:0031:lowes'),
      ('pressure washers',                     'outdoor-power',       'seed:0031:lowes'),
      ('leaf blowers',                         'outdoor-power',       'seed:0031:lowes'),
      ('string trimmers and augers',           'outdoor-power',       'seed:0031:lowes'),
      ('battery mowers',                       'outdoor-power',       'seed:0031:lowes'),
      ('chainsaws & polesaws',                 'outdoor-power',       'seed:0031:lowes'),
      ('bath fans',                            'bath-hardware',       'seed:0031:lowes'),
      ('bath faucets',                         'faucets-fixtures',    'seed:0031:lowes'),
      ('kitchen faucets',                      'faucets-fixtures',    'seed:0031:lowes'),
      ('kitchen sinks',                        'faucets-fixtures',    'seed:0031:lowes'),
      ('toilet seats',                         'bath-hardware',       'seed:0031:lowes'),
      ('toilet repair',                        'plumbing',            'seed:0031:lowes'),
      ('faucet repair',                        'plumbing',            'seed:0031:lowes'),
      ('tubular drains & strainers',           'plumbing',            'seed:0031:lowes'),
      ('supply lines',                         'plumbing',            'seed:0031:lowes'),
      ('wiring devices',                       'electrical',          'seed:0031:lowes'),
      ('electrical boxes',                     'electrical',          'seed:0031:lowes'),
      ('extension cords',                      'electrical',          'seed:0031:lowes'),
      ('pvc conduit & fittings',               'electrical',          'seed:0031:lowes'),
      ('thermostats and hvac accessories',     'hvac',                'seed:0031:lowes'),
      ('registers and grills',                 'hvac',                'seed:0031:lowes'),
      ('ductwork',                             'hvac',                'seed:0031:lowes'),
      ('air filters',                          'hvac',                'seed:0031:lowes'),
      ('vinyl flooring',                       'flooring',            'seed:0031:lowes'),
      ('flooring tools',                       'flooring',            'seed:0031:lowes'),
      ('closet organization',                  'storage-organization', 'seed:0031:lowes'),
      ('garage organization',                  'storage-organization', 'seed:0031:lowes'),
      ('blinds and shades',                    'window-treatments',   'seed:0031:lowes'),
      ('drapery hardware',                     'window-treatments',   'seed:0031:lowes'),
      ('soft window',                          'window-treatments',   'seed:0031:lowes'),
      ('paint sprayers',                       'paint-decor',         'seed:0031:lowes'),
      ('hand saws',                            'hand-tools',          'seed:0031:lowes'),
      ('hammers',                              'hand-tools',          'seed:0031:lowes'),
      ('measuring tools',                      'hand-tools',          'seed:0031:lowes'),
      ('utility knives',                       'hand-tools',          'seed:0031:lowes'),
      ('miter and table saws',                 'power-tools',         'seed:0031:lowes'),
      ('compressors diy and stationary',       'power-tools',         'seed:0031:lowes'),
      ('cutting bare tools',                   'power-tools',         'seed:0031:lowes'),
      ('cordless batteries & chargers',        'power-tools',         'seed:0031:lowes'),
      ('benchtop tools',                       'power-tools',         'seed:0031:lowes'),
      ('pneumatics',                           'power-tools',         'seed:0031:lowes'),
      ('kobalt mech tools',                    'hand-tools',          'seed:0031:lowes'),
      ('grills',                               'grills-cooking',      'seed:0031:lowes'),
      ('grill accessories',                    'grills-cooking',      'seed:0031:lowes'),
      ('fireplaces logs and stoves',           'hvac',                'seed:0031:lowes'),
      ('refrigerator accessories',             'major-appliances',    'seed:0031:lowes'),
      ('disposers',                            'major-appliances',    'seed:0031:lowes'),
      ('small appliances',                     'small-appliances',    'seed:0031:lowes'),
      ('floorcare',                            'small-appliances',    'seed:0031:lowes'),
      ('wet dry vac',                          'small-appliances',    'seed:0031:lowes'),
      ('mailboxes and posts',                  'outdoor-garden',      'seed:0031:lowes'),
      ('planters',                             'garden-plants',       'seed:0031:lowes'),
      ('ponds and fountains',                  'outdoor-garden',      'seed:0031:lowes'),
      ('year round outdoor decor',             'outdoor-garden',      'seed:0031:lowes'),
      ('locksets',                             'hardware',            'seed:0031:lowes'),
      ('padlocks',                             'hardware',            'seed:0031:lowes'),
      ('cabinet hardware',                     'hardware',            'seed:0031:lowes'),
      ('functional cabinet hardware',          'hardware',            'seed:0031:lowes'),
      ('fasteners',                            'hardware',            'seed:0031:lowes'),
      ('nails and screws',                     'hardware',            'seed:0031:lowes'),
      ('hollow wall anchors',                  'hardware',            'seed:0031:lowes'),
      ('door and home hardware',               'hardware',            'seed:0031:lowes'),
      ('gate hardware',                        'hardware',            'seed:0031:lowes'),
      ('bathroom and pedestal sinks',          'showers-tubs',        'seed:0031:lowes'),
      ('showering products',                   'showers-tubs',        'seed:0031:lowes'),
      ('doormats, scatter and bath rugs',      'rugs-mats',           'seed:0031:lowes'),
      ('decor shelving',                       'home-decor',          'seed:0031:lowes'),
      ('wall decor',                           'home-decor',          'seed:0031:lowes')
    ) AS t(raw, slug, source)
  LOOP
    INSERT INTO category_aliases (raw, category_id, source, confidence)
    SELECT r.raw, c.id, r.source, 0.85
    FROM categories c
    WHERE c.slug = r.slug
    ON CONFLICT (raw) DO UPDATE
      SET category_id = EXCLUDED.category_id,
          source      = EXCLUDED.source,
          confidence  = EXCLUDED.confidence;
  END LOOP;
END $$;
