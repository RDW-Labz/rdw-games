-- ============================================================================
-- 0055_lot_source
--
-- Adds a free-form `source` label to every lot. Operators tag lots with
-- the truck / pallet / program they came from (e.g. "Truck 47L 5/9",
-- "Amazon Returns Pallet 5/9", "Walmart Wednesday") at lotting time so
-- profitability reports can later group by source — "which trucks make
-- money?" is the canonical question this column answers.
--
-- Free-form on purpose: operators have wildly varied naming conventions
-- and a constrained enum would force premature standardization. A
-- partial index over the column lets us still slice efficiently when
-- the operator filters /inventory by source.
--
-- Length capped at 120 chars to match the lots.external_code cap and
-- prevent runaway-text DOS via the 0050 pattern.
-- ============================================================================

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS source TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lots_source_length_sane'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_source_length_sane
      CHECK (source IS NULL OR length(source) <= 120);
  END IF;
END $$;

-- Operator-scoped index for "show me all lots from Truck 47L". Partial
-- because source is null for legacy lots — the index doesn't pay for
-- those.
CREATE INDEX IF NOT EXISTS lots_source_idx
  ON lots (operator_id, source)
  WHERE source IS NOT NULL;

COMMENT ON COLUMN lots.source IS
  '0055: free-form source/truck/program label set at lotting time. Used for profitability segmentation. NULL for legacy lots.';
