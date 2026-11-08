-- migration 0140 — lots.reserve_cents (W11, future-proof reserve-price column)
--
-- Per docs/state/PLAN-field-mobile-restructure-2026-05-25.md W11:
--   "Add `lots.reserve_cents BIGINT NULL` migration … NULL means
--    'no reserve' … No bidding logic enforcement yet."
--
-- The bidding RPCs (place_bid, finalize_lot, auction-engine cron) do NOT
-- read this column as of W11. It is a forward-compatibility column so
-- that:
--   1) lotting UIs can capture a reserve price during draft creation
--      (review tab of `EditableCandidateCard`).
--   2) future migrations can wire it into bidding logic without a
--      table-shape change against rows that already exist.
--
-- Operators opt in to the UI input later via the `reserve_pricing_enabled`
-- feature flag on the operators table (deferred until enforcement ships;
-- see Resolved Decision #2 in the plan).
--
-- Sanity constraint mirrors the starting_bid_cents shape (>= 1 cent and
-- below the $1B cap), but NULL is the default and most common value.
-- If reserve_cents is non-null, callers should also ensure
-- reserve_cents >= starting_bid_cents at the application layer; we do
-- NOT add a DB CHECK for that cross-column relationship because legitimate
-- "no-bid until reserve met" pricing models may set reserve below the
-- starting bid (the starting bid is the floor at which bidding opens;
-- the reserve is the floor at which the lot can sell).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + DO-block guard on the CHECK.

BEGIN;

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS reserve_cents BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'lots_reserve_cents_sane'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_reserve_cents_sane
      CHECK (
        reserve_cents IS NULL
        OR (reserve_cents >= 1 AND reserve_cents < 100000000000)
      );
  END IF;
END $$;

COMMENT ON COLUMN public.lots.reserve_cents IS
  'Future reserve-price floor in cents. NULL = no reserve (default). '
  'NOT enforced by bidding RPCs as of migration 0140 (W11). Wiring '
  'into place_bid / finalize_lot is a follow-up workstream. UI input '
  'is gated behind operators.reserve_pricing_enabled (deferred).';

COMMENT ON CONSTRAINT lots_reserve_cents_sane ON public.lots IS
  'W11: cap on absurd reserve values; mirrors lots_starting_bid_cents_sane shape. NULL allowed (no reserve).';

COMMIT;
