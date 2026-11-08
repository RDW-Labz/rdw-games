-- ============================================================================
-- 0058_drop_external_code_unique
--
-- Architectural fix: external_code is a SEARCH HINT, not a unique
-- identifier. Two physical units of the same product (UPC, ASIN, FNSKU)
-- are legitimately TWO separate lots — each gets its own app-wide
-- unique lot_code. Forcing UNIQUE on (operator_id, external_code)
-- blocked the common case ("I have 50 of these AirPods, lot all 50")
-- in service of an edge case (some operators import pre-stickered
-- inventory where each sticker was unique).
--
-- The lot_code partial UNIQUE index from migration 0021 still
-- guarantees app-wide unique IDs — that's the canonical identifier
-- that gets printed on thermal labels and scanned at intake. UPC
-- stays in external_code as a search/lookup hint with no uniqueness
-- enforcement.
--
-- Why this fixes "duplicate UPC" save errors:
--   The Quick Lot + Scan flows write candidate.upc → external_code.
--   Operators lotting a pallet of identical items (perfectly normal
--   scenario) hit the UNIQUE on the second item. After this migration,
--   they can lot 100 of the same UPC; each becomes a separate lot
--   with its own lot_code. At intake the operator scans the printed
--   lot_code (not the UPC) to disambiguate which physical item is
--   being put away.
--
-- What we keep:
--   - lots_lot_code_unique partial UNIQUE      → canonical ID, stays
--   - lots_auction_lot_number_unique           → per-auction lot #s, stays
--   - The non-unique read index on
--     (operator_id, external_code) WHERE external_code IS NOT NULL
--     stays as a regular index for fast lookups.
--
-- Idempotent: DROP INDEX IF EXISTS.
-- ============================================================================

-- Drop the unique constraint. The index name is the same since the
-- index IS the constraint (created via CREATE UNIQUE INDEX in 0023).
DROP INDEX IF EXISTS lots_external_code_per_operator;

-- Recreate as a NON-unique index so external_code lookups still hit
-- an index. Same predicate as the original unique index. The
-- pre-existing lots_external_code_lookup_idx from 0023 (also non-
-- unique) stays as is — having two non-unique indexes on the same
-- (operator_id, external_code) WHERE clause is redundant but
-- harmless; cleaning up the duplicate is a low-priority follow-up.
-- We don't recreate one in this migration because the LOOKUP index
-- already exists.

COMMENT ON INDEX lots_external_code_lookup_idx IS
  '0058: lookup index for operator-scoped external_code reads. Was previously paired with a UNIQUE index that was dropped — UPC/ASIN/FNSKU are search hints, not unique identifiers. lot_code (operator-prefixed sequence) is the canonical unique ID per migration 0021.';
