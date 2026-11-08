-- ============================================================================
-- 0050_lot_text_length_checks
--
-- Reject implausibly long title / description on lots. Pre-flight on
-- 598 production rows: max title 238 chars, max description 238 chars.
-- Caps chosen to leave plenty of headroom for legitimate lots while
-- blocking the runaway-text failure mode that any UI displaying these
-- columns truncated would surface as broken layout.
--
--   title:        500 chars (≈ 2× the longest seen in real data)
--   description: 10000 chars (≈ 50× the longest seen)
--
-- Idempotent: ADD CONSTRAINT IF NOT EXISTS via DO block.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lots_title_length_sane'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_title_length_sane
      CHECK (length(title) > 0 AND length(title) <= 500);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lots_description_length_sane'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_description_length_sane
      CHECK (description IS NULL OR length(description) <= 10000);
  END IF;
END $$;

COMMENT ON CONSTRAINT lots_title_length_sane ON public.lots IS
  'R6.2: reject empty or implausibly long titles. Cap = 500 chars (~2x longest in real data).';
COMMENT ON CONSTRAINT lots_description_length_sane ON public.lots IS
  'R6.2: cap descriptions at 10k chars to prevent UI breakage and runaway-text DOS.';
