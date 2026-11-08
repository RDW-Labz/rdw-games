-- ============================================================================
-- Operator-defined external identifier per lot.
--
-- Operators sometimes import manifests of pre-stickered inventory —
-- the supplier already put a SKU / UPC / job number / route stop ID
-- on each box. The operator wants to scan THAT existing sticker at
-- intake without printing new RDW-000XYZ labels.
--
-- Schema choices:
--   - external_code is per-operator unique, NOT app-wide unique. Two
--     operators legitimately importing from the same supplier could
--     have the same SKUs — that's fine, the system distinguishes by
--     operator_id.
--   - Nullable. Lots created manually or by an operator that doesn't
--     map an external column have no external_code; they're scanned
--     by lot_code only.
--   - Not part of the lot_code generation. Lot_code is OUR primary
--     identifier; external_code is a *secondary* lookup key the
--     operator brought with them.
-- ============================================================================

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS external_code TEXT;

-- Operator-scoped uniqueness. Postgres allows multiple NULLs in a
-- partial UNIQUE index, so lots without an external_code don't
-- conflict with each other.
CREATE UNIQUE INDEX IF NOT EXISTS lots_external_code_per_operator
  ON lots (operator_id, external_code)
  WHERE external_code IS NOT NULL;

-- Operator-scoped read index for intake lookups.
CREATE INDEX IF NOT EXISTS lots_external_code_lookup_idx
  ON lots (operator_id, external_code)
  WHERE external_code IS NOT NULL;
