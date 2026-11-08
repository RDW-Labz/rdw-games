-- ============================================================================
-- Bulk import audit trail.
--
-- Every CSV/XLSX manifest the operator uploads lands here as one row,
-- so the operator can see "what did I import last Thursday and how
-- many lots came in." Lot rows reference back to their source
-- import via lots.import_id.
--
-- Schema choices:
--   - imports table is per-operator audit. Service role + operator
--     staff can read.
--   - Mapping is stored as JSONB so future smart-import features
--     (AI title generation, category overrides) don't need migrations.
--   - row_count is denormalized count of lots created from this
--     import; updated by the server action after the bulk insert.
-- ============================================================================

CREATE TABLE IF NOT EXISTS imports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id   UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  source_label  TEXT,                                 -- 'lowes', 'wayfair', 'home depot', 'manual'
  mapping       JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count     INTEGER NOT NULL DEFAULT 0,
  classified_count INTEGER NOT NULL DEFAULT 0,        -- # rows where category_id auto-resolved
  status        TEXT NOT NULL DEFAULT 'completed',     -- 'completed' / 'failed'
  error         TEXT,
  created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS imports_operator_recent_idx
  ON imports (operator_id, created_at DESC);

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS import_id UUID REFERENCES imports(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lots_import_idx ON lots (import_id);

-- ----------------------------------------------------------------------------
-- RLS — operator staff read their own imports. Writes via service role
-- only (the server action has admin client).
-- ----------------------------------------------------------------------------

ALTER TABLE imports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS imports_staff_read ON imports;
CREATE POLICY imports_staff_read ON imports
  FOR SELECT USING (operator_id = current_operator_id());
