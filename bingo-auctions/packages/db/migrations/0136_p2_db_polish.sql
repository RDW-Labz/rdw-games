-- ============================================================================
-- Migration 0136 — P2 DB polish (DB-11..14 from 2026-05-24 audit)
--
-- Four small constraint / type tightenings. Additive, idempotent, no data
-- migration risk on current row volumes (confidence/status values already
-- conform to the proposed CHECKs; discount_pct cast preserves 2-decimal
-- precision).
-- ============================================================================

-- ── DB-11: UUID v4 PK fragmentation (POLICY ONLY, NO DATA CHANGE) ────────────
-- Random UUIDs fragment B-tree indexes badly. UUIDv7 (time-ordered) or
-- bigint sequences would pack better. We DO NOT rewrite existing PKs here —
-- that's per-table surgery touching every FK. Document the policy + provide
-- an audit query so future tables can choose better defaults.
--
-- Policy: new tables SHOULD use UUIDv7 (via pg_uuidv7 extension when
-- adopted) or BIGINT identity for high-volume write paths. Random v4 is
-- acceptable only for low-volume reference tables.
--
-- Audit query (run manually to see candidates for conversion):
--   SELECT n.nspname, c.relname, a.attname,
--          pg_get_expr(ad.adbin, ad.adrelid) AS default_expr
--   FROM pg_attrdef ad
--   JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
--   JOIN pg_class c ON c.oid = ad.adrelid
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE pg_get_expr(ad.adbin, ad.adrelid) ILIKE '%uuid_generate_v4%'
--      OR pg_get_expr(ad.adbin, ad.adrelid) ILIKE '%gen_random_uuid%'
--   ORDER BY n.nspname, c.relname;

COMMENT ON SCHEMA public IS
  'New tables: prefer UUIDv7 or BIGINT identity for write-hot tables. '
  'Audit existing v4 PKs via the query in migration 0136. See DB-11.';

-- ── DB-12: product_lookups.confidence CHECK ──────────────────────────────────
-- The column comment in 0027 documents the value set; the constraint makes
-- it enforceable. Existing rows must already conform — verify before deploy:
--   SELECT DISTINCT confidence FROM product_lookups;
-- Expected values: 'high', 'medium', 'low', 'none'.

ALTER TABLE product_lookups
  DROP CONSTRAINT IF EXISTS product_lookups_confidence_check;

ALTER TABLE product_lookups
  ADD CONSTRAINT product_lookups_confidence_check
  CHECK (confidence IN ('high', 'medium', 'low', 'none'));

-- ── DB-13: lot_import_batches.status CHECK ───────────────────────────────────
-- 0131 expanded the value set beyond what 0103's column comment listed.
-- Current observable values: 'processing' (in-flight), 'completed' (success),
-- 'failed' (loop EXCEPTION caught), 'partial' (some rows skipped),
-- 'rolled_back' (manual rollback). Constrain to that exact set.

ALTER TABLE lot_import_batches
  DROP CONSTRAINT IF EXISTS lot_import_batches_status_check;

ALTER TABLE lot_import_batches
  ADD CONSTRAINT lot_import_batches_status_check
  CHECK (status IN ('processing', 'completed', 'failed', 'partial', 'rolled_back'));

-- ── DB-14: competitor_lots.discount_pct REAL → NUMERIC(6,2) ──────────────────
-- REAL is IEEE-754 single precision — 7 decimal digits, float drift.
-- A discount percentage with 2-decimal precision and max ~9999.99 fits
-- comfortably in NUMERIC(6,2). USING cast preserves existing values rounded
-- to 2 decimals. Indexes on this column (if any) are rebuilt automatically.

ALTER TABLE competitor_lots
  ALTER COLUMN discount_pct TYPE NUMERIC(6,2)
  USING discount_pct::numeric(6,2);

COMMENT ON COLUMN competitor_lots.discount_pct IS
  'Percentage discount vs MSRP. NUMERIC(6,2) — exact, no float drift. '
  'Range [0.00, 9999.99] (capped well above any realistic discount).';

-- ── Verification ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_constraints INTEGER;
  v_dtype       TEXT;
BEGIN
  SELECT count(*) INTO v_constraints
  FROM information_schema.check_constraints
  WHERE constraint_name IN (
    'product_lookups_confidence_check',
    'lot_import_batches_status_check'
  );
  IF v_constraints <> 2 THEN
    RAISE EXCEPTION 'Migration 0136 verification failed: expected 2 new CHECK constraints, found %', v_constraints;
  END IF;

  SELECT data_type INTO v_dtype
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'competitor_lots'
    AND column_name = 'discount_pct';
  IF v_dtype IS DISTINCT FROM 'numeric' THEN
    RAISE EXCEPTION 'Migration 0136 verification failed: competitor_lots.discount_pct expected numeric, got %', v_dtype;
  END IF;

  RAISE NOTICE 'Migration 0136 verified: 2 CHECK constraints + discount_pct = NUMERIC';
END $$;
