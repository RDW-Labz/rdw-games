-- ============================================================================
-- 0046_lot_value_constraints
--
-- Mirror of R4.2 application-layer guards in
-- packages/domain-lotting/src/persistence.ts. Catches any path that bypasses
-- the TS guard (direct service-role inserts, future RPC paths, manual SQL).
--
-- Concretely defends against:
--   - msrp_cents above JS Number.MAX_SAFE_INTEGER (9_007_199_254_740_991).
--     Above this point JavaScript Number arithmetic silently loses
--     precision, and the stored value is mathematically wrong but still
--     fits in BIGINT, so no DB error fires. The CHECK forces the data
--     stream to reject the value at the boundary.
--   - msrp_cents <= 0 (free or negative MSRP makes no sense).
--   - starting_bid_cents above $1B (10^11 cents). The platform's bid
--     UX, ledger, and Stripe integration aren't designed for absurd
--     values; cap is loose enough that legitimate luxury auctions still
--     fit, tight enough that overflow / typos don't slip through.
--   - starting_bid_cents < 1 cent (DEFAULT 100 = $1.00 floor matches
--     manifest importer; <1 cent would mean "anyone can win for free").
--
-- Pre-flight (run 2026-05-08): 0 rows in production violate any of the
-- below thresholds, so the constraints can be added with no backfill.
--
-- Idempotent: ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS via DO block,
-- since Postgres doesn't have IF NOT EXISTS for ADD CONSTRAINT directly.
-- ============================================================================

DO $$
BEGIN
  -- msrp_cents: NULL allowed (unknown MSRP); otherwise > 0 and < MAX_SAFE_INTEGER.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'lots_msrp_cents_sane'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_msrp_cents_sane
      CHECK (
        msrp_cents IS NULL
        OR (msrp_cents > 0 AND msrp_cents < 9007199254740991)
      );
  END IF;

  -- starting_bid_cents: required, >= 1 cent, < $1B in cents.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'lots_starting_bid_cents_sane'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_starting_bid_cents_sane
      CHECK (
        starting_bid_cents >= 1
        AND starting_bid_cents < 100000000000
      );
  END IF;
END $$;

COMMENT ON CONSTRAINT lots_msrp_cents_sane ON public.lots IS
  'R4.2: catch JS float-precision overflow above MAX_SAFE_INTEGER. Mirror of the cap in persistence.ts. Rejects 0/negative/silent-corruption values.';
COMMENT ON CONSTRAINT lots_starting_bid_cents_sane ON public.lots IS
  'R4.2: cap absurd starting bids; default floor is $1.00 (100 cents). Rejects free-or-overflow values.';
