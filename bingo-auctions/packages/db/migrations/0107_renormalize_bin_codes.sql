-- ============================================================================
-- Migration 0107 — Renormalize bin codes so numeric segments are LPAD'd to
-- 2 digits.
--
-- Backstory
-- ---------
-- The operator-web bulk-create path (apps/operator-web/.../bins/actions.ts
-- :createBinsBulk) padded the `bay` and `position` segments to 2 digits
-- but emitted the `level` segment unpadded. Operators creating bays 1–5
-- with levels 1–20 got codes like:
--
--   Right-01-1
--   Right-01-2
--   …
--   Right-01-10
--   …
--   Right-01-20
--
-- The bins admin table and the QR-sheet route both sort with `.order('code')`,
-- which Postgres does lexicographically. That sort interleaves widths and
-- produced the "out of order" QR sheet the operator reported on 2026-05-21:
--   Right-01-1, Right-01-10, Right-01-11, … Right-01-19, Right-01-2,
--   Right-01-20, Right-01-3, …
--
-- The generator was fixed in the same PR as this migration. This migration
-- rewrites any rows that were created before the fix landed. Because the
-- iPad scans by `qr_token` (UUID), changing the human-readable `code` is
-- safe — no scanner state breaks.
--
-- Scope
-- -----
-- Only rewrites codes that match the unpadded-tail patterns, leaving
-- already-correct codes alone. Idempotent: re-running is a no-op.
--
-- Patterns rewritten:
--   prefix-D     (3-part, single-digit level)        -> prefix-0D
--   prefix-D-NN  (4-part, single-digit level)        -> prefix-0D-NN
--   prefix-NN-D  (4-part, single-digit position)     -> prefix-NN-0D
--
-- where:
--   prefix = anything up to the last numeric segment(s)
--   D      = single decimal digit (0-9)
--   NN     = already-padded 2-digit numeric segment
--
-- Within a warehouse (warehouse_id, code) is UNIQUE — but renormalization
-- maps each old code to exactly one new code, so collisions only happen
-- when someone hand-created a colliding "Right-01-02" alongside the
-- generator's "Right-01-2". The UPDATEs below skip any row whose target
-- code already exists in the same warehouse and surface a NOTICE so the
-- operator can resolve manually.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Safety net: detect collisions BEFORE any UPDATE runs.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_collision_count INTEGER;
BEGIN
  WITH candidates AS (
    SELECT
      id,
      warehouse_id,
      code,
      CASE
        WHEN code ~ '^(.+)-([0-9])$'            THEN regexp_replace(code, '^(.+)-([0-9])$',            '\1-0\2')
        WHEN code ~ '^(.+)-([0-9])-([0-9]{2})$' THEN regexp_replace(code, '^(.+)-([0-9])-([0-9]{2})$', '\1-0\2-\3')
        WHEN code ~ '^(.+)-([0-9]{2})-([0-9])$' THEN regexp_replace(code, '^(.+)-([0-9]{2})-([0-9])$', '\1-\2-0\3')
        ELSE code
      END AS new_code
    FROM bins
  ),
  changes AS (
    SELECT warehouse_id, new_code
    FROM candidates
    WHERE new_code <> code
  )
  SELECT COUNT(*)
    INTO v_collision_count
  FROM changes c
  JOIN bins b
    ON b.warehouse_id = c.warehouse_id
   AND b.code         = c.new_code;

  IF v_collision_count > 0 THEN
    RAISE NOTICE
      'Renormalization would collide with % existing code(s). The UPDATEs '
      'below will SKIP rows whose target code already exists. Resolve any '
      'remaining mixed-padding pairs manually.',
      v_collision_count;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Apply the rewrite. Each UPDATE skips rows whose target already exists
-- in the same warehouse so the (warehouse_id, code) unique constraint is
-- never violated.
-- ---------------------------------------------------------------------------

UPDATE bins AS b
   SET code = regexp_replace(b.code, '^(.+)-([0-9])$', '\1-0\2'),
       updated_at = now()
 WHERE b.code ~ '^(.+)-([0-9])$'
   AND NOT EXISTS (
     SELECT 1 FROM bins b2
     WHERE b2.warehouse_id = b.warehouse_id
       AND b2.code = regexp_replace(b.code, '^(.+)-([0-9])$', '\1-0\2')
       AND b2.id <> b.id
   );

UPDATE bins AS b
   SET code = regexp_replace(b.code, '^(.+)-([0-9])-([0-9]{2})$', '\1-0\2-\3'),
       updated_at = now()
 WHERE b.code ~ '^(.+)-([0-9])-([0-9]{2})$'
   AND NOT EXISTS (
     SELECT 1 FROM bins b2
     WHERE b2.warehouse_id = b.warehouse_id
       AND b2.code = regexp_replace(b.code, '^(.+)-([0-9])-([0-9]{2})$', '\1-0\2-\3')
       AND b2.id <> b.id
   );

UPDATE bins AS b
   SET code = regexp_replace(b.code, '^(.+)-([0-9]{2})-([0-9])$', '\1-\2-0\3'),
       updated_at = now()
 WHERE b.code ~ '^(.+)-([0-9]{2})-([0-9])$'
   AND NOT EXISTS (
     SELECT 1 FROM bins b2
     WHERE b2.warehouse_id = b.warehouse_id
       AND b2.code = regexp_replace(b.code, '^(.+)-([0-9]{2})-([0-9])$', '\1-\2-0\3')
       AND b2.id <> b.id
   );
