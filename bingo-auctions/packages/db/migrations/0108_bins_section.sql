-- ============================================================================
-- Migration 0108 — Add bins.section for named bay groupings.
--
-- Operators with a few hundred bins per warehouse asked for a way to print
-- QR labels one zone at a time (cold storage, electronics, returns table).
-- The existing layout dimensions (aisle / bay / level / position) do not
-- carry semantic grouping — "Aisle Right" doesn't tell you which physical
-- area of the warehouse it's in.
--
-- `section` is a free-text label the operator can assign per-bin (or in
-- bulk via the bins admin UI). NULL = unsectioned. The print-by-section
-- UI lists distinct non-null values as the picker options.
--
-- Why TEXT and not a separate sections table?
-- -------------------------------------------
-- We considered modeling sections as their own table with FK references.
-- For the current scale (a handful of named zones per warehouse, edited
-- rarely) a free-text column on bins is enough and removes the overhead
-- of a relationship. If sections grow into a first-class entity (with
-- colors, icons, capacity limits, pickup-mode overrides, etc.) we can
-- migrate to a sections table later — the section text becomes the
-- denormalized display name.
--
-- The `scanned_at` column needed for "Print unverified only" already
-- exists from migration 0102 (warehouse_walk_mode). The
-- stamp_bin_walk_position RPC writes it on every walk-mode scan, so no
-- new instrumentation is required for the unverified filter.
-- ============================================================================

ALTER TABLE bins ADD COLUMN IF NOT EXISTS section TEXT;

COMMENT ON COLUMN bins.section IS
  'Optional named zone for the bin (e.g. "Cold Storage", "Electronics", '
  '"Returns"). Free-text. NULL = unsectioned. Used by the bin admin page '
  'to filter prints by zone and the QR-sheet route to scope a label batch '
  'to one section.';

-- Lightweight index — section filters and DISTINCT lookups in the bin
-- admin UI hit this. Partial-on-not-null keeps the index small since most
-- bins start unsectioned.
CREATE INDEX IF NOT EXISTS bins_warehouse_section_idx
  ON bins (warehouse_id, section)
  WHERE section IS NOT NULL;
