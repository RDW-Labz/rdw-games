-- 0184_amazon_toplevel_category_aliases.sql
--
-- A4 (live-test category-filter fix). The bidder + web category filter keys on
-- lots.category_id. ~6,155 imported lots had category_id = NULL because the 296
-- existing category_aliases are hardware / home-improvement-tuned and match NONE
-- of the Amazon-returns taxonomy ("Toys & Games > Puzzles",
-- "Health & Household > Medical Supplies & Equipment", ...) that BinGo's manifests
-- use. So selecting any category returned nothing; lots only showed under "All".
--
-- resolve_category_id (mig 0033) resolves a category string by LONGEST-SUBSTRING
-- match against category_aliases.raw (lower/trim'd). Adding the 5 Amazon top-level
-- segments therefore maps the whole "TopLevel > Sub" string to a sensible platform
-- category. This is COARSE by design (top-level only, confidence 0.6); finer leaf
-- aliases (e.g. "video games" -> gaming, "puzzles" -> board-games) can be added
-- later without conflict (longest-substring will prefer a longer leaf alias only
-- if it is longer than the top-level one).
--
-- Companion (existing rows): run  node scripts/backfill-lot-categories.mjs --live
-- after this migration to repair the lots that were imported before it.
-- New imports are already covered: bulk_import_lots (mig 0178) calls
-- resolve_category_id at insert time, so it will now resolve these segments too.

INSERT INTO category_aliases (raw, category_id, source, confidence)
SELECT m.raw, c.id, 'amazon-toplevel-2026-06-04', 0.6
FROM (VALUES
  ('toys & games',            'toys-games'),
  ('health & household',      'health'),
  ('books',                   'books-media'),
  ('office products',         'office-school'),
  ('industrial & scientific', 'industrial-business')
) AS m(raw, slug)
JOIN categories c ON c.slug = m.slug
ON CONFLICT (raw) DO NOTHING;

-- Self-mark (matches the repo's plain-psql migration pattern, e.g. 0033).
INSERT INTO _schema_migrations (filename, applied_by) VALUES
  ('0184_amazon_toplevel_category_aliases.sql', 'manual:0184')
ON CONFLICT (filename) DO NOTHING;
