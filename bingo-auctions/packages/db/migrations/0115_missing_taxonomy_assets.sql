-- ============================================================================
-- 0115_missing_taxonomy_assets.sql
--
-- Backfills image_url + icon_url for the 8 category leaves that had no
-- asset coverage in the first asset pack drop. A follow-up pack ("missing
-- taxonomy assets") added imagery for these specific slugs.
--
-- Pack source:
--   /tmp/clovrbid-missing/clovrbid_missing_taxonomy_assets_ready/
--
-- CDN URL convention (different from pack 1 — this pack uses underscore-
-- separated filenames within underscore-prefixed folders):
--   image_url → /02_category_cards_exact_labels/{slug}_category_card_800x600.webp
--   icon_url  → /06_simple_category_icons/{slug}_icon_512.png
--
-- Safe to re-run: WHERE image_url IS NULL guards prevent overwriting any
-- manual edits operators may have made.
-- ============================================================================

UPDATE categories SET
  image_url = 'https://cdn.clovrbid.com/02_category_cards_exact_labels/bath-hardware_category_card_800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/06_simple_category_icons/bath-hardware_icon_512.png',
  pack_slug = 'bath-hardware'
WHERE slug = 'bath-hardware' AND image_url IS NULL;

UPDATE categories SET
  image_url = 'https://cdn.clovrbid.com/02_category_cards_exact_labels/faucets-fixtures_category_card_800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/06_simple_category_icons/faucets-fixtures_icon_512.png',
  pack_slug = 'faucets-fixtures'
WHERE slug = 'faucets-fixtures' AND image_url IS NULL;

UPDATE categories SET
  image_url = 'https://cdn.clovrbid.com/02_category_cards_exact_labels/showers-tubs_category_card_800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/06_simple_category_icons/showers-tubs_icon_512.png',
  pack_slug = 'showers-tubs'
WHERE slug = 'showers-tubs' AND image_url IS NULL;

UPDATE categories SET
  image_url = 'https://cdn.clovrbid.com/02_category_cards_exact_labels/vanities_category_card_800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/06_simple_category_icons/vanities_icon_512.png',
  pack_slug = 'vanities'
WHERE slug = 'vanities' AND image_url IS NULL;

UPDATE categories SET
  image_url = 'https://cdn.clovrbid.com/02_category_cards_exact_labels/plumbing_category_card_800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/06_simple_category_icons/plumbing_icon_512.png',
  pack_slug = 'plumbing'
WHERE slug = 'plumbing' AND image_url IS NULL;

UPDATE categories SET
  image_url = 'https://cdn.clovrbid.com/02_category_cards_exact_labels/hvac_category_card_800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/06_simple_category_icons/hvac_icon_512.png',
  pack_slug = 'hvac'
WHERE slug = 'hvac' AND image_url IS NULL;

UPDATE categories SET
  image_url = 'https://cdn.clovrbid.com/02_category_cards_exact_labels/flooring_category_card_800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/06_simple_category_icons/flooring_icon_512.png',
  pack_slug = 'flooring'
WHERE slug = 'flooring' AND image_url IS NULL;

UPDATE categories SET
  image_url = 'https://cdn.clovrbid.com/02_category_cards_exact_labels/food-pantry_category_card_800x600.webp',
  icon_url  = 'https://cdn.clovrbid.com/06_simple_category_icons/food-pantry_icon_512.png',
  pack_slug = 'food-pantry'
WHERE slug = 'food-pantry' AND image_url IS NULL;
