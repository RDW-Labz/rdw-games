-- ============================================================================
-- Auction format expansion + bidder subscriptions.
--
-- Three auction formats now:
--   - 'standard'    proxy/max bidding with soft-close (the original)
--   - 'dutch'       declining-price ticker, first buyer wins at current price
--   - 'last_chance' flat-price first-come-first-served on unsold inventory
--
-- Bidder subscriptions add:
--   - subscription_status, subscription_expires_at, stripe_subscription_id
-- And a new lot field early_access_until that subscribers see this many
-- minutes earlier than public.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Auction format enum
-- ----------------------------------------------------------------------------

CREATE TYPE auction_format AS ENUM ('standard', 'dutch', 'last_chance');

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS format auction_format NOT NULL DEFAULT 'standard';

-- ----------------------------------------------------------------------------
-- Lot extensions for non-standard formats.
--   - flat_price_cents:  price for last_chance lots
--   - dutch_start_cents: opening price for dutch lots (declines linearly)
--   - dutch_floor_cents: minimum price (where the decline stops)
--   - dutch_decline_per_minute_cents: how fast the price drops
--
-- early_access_until is a TIMESTAMPTZ before which only subscribers can see
-- the lot; auctions can be configured to open early-access automatically by
-- offsetting from starts_at.
-- ----------------------------------------------------------------------------

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS flat_price_cents BIGINT,
  ADD COLUMN IF NOT EXISTS dutch_start_cents BIGINT,
  ADD COLUMN IF NOT EXISTS dutch_floor_cents BIGINT,
  ADD COLUMN IF NOT EXISTS dutch_decline_per_minute_cents BIGINT,
  ADD COLUMN IF NOT EXISTS early_access_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS lots_early_access_idx ON lots (early_access_until)
  WHERE early_access_until IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Bidder subscription columns
-- ----------------------------------------------------------------------------

CREATE TYPE subscription_status AS ENUM ('none', 'trialing', 'active', 'past_due', 'canceled');

ALTER TABLE bidders
  ADD COLUMN IF NOT EXISTS subscription_status subscription_status NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS bidders_subscription_idx ON bidders (subscription_status)
  WHERE subscription_status IN ('active', 'trialing');

-- ----------------------------------------------------------------------------
-- Helper: is the calling user a paying subscriber?
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION is_subscriber()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM bidders
    WHERE id = auth.uid()
      AND subscription_status IN ('active', 'trialing')
      AND (subscription_expires_at IS NULL OR subscription_expires_at > now())
  );
$$;

-- Refresh the bidder lot-read policy to honor early_access_until + subscription.
DROP POLICY IF EXISTS lots_bidder_read_published ON lots;
CREATE POLICY lots_bidder_read_published ON lots
  FOR SELECT USING (
    is_bidder()
    AND status IN ('scheduled', 'live', 'won', 'unsold', 'relisted')
    AND (early_access_until IS NULL OR early_access_until <= now() OR is_subscriber())
  );

-- ----------------------------------------------------------------------------
-- compute_dutch_current_price(lot_id, at_time)
--   Returns the current price for a Dutch lot, clamped to floor.
--   Linear decline from dutch_start_cents at lot's auction.starts_at toward
--   dutch_floor_cents, at dutch_decline_per_minute_cents per minute.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION compute_dutch_current_price(
  p_lot_id UUID,
  p_at TIMESTAMPTZ DEFAULT now()
)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot lots%ROWTYPE;
  v_auction auctions%ROWTYPE;
  v_minutes_elapsed NUMERIC;
  v_price BIGINT;
BEGIN
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id;
  IF NOT FOUND OR v_lot.dutch_start_cents IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_auction FROM auctions WHERE id = v_lot.auction_id;

  v_minutes_elapsed := GREATEST(
    0,
    EXTRACT(EPOCH FROM (p_at - v_auction.starts_at)) / 60.0
  );

  v_price := v_lot.dutch_start_cents -
             (v_minutes_elapsed * COALESCE(v_lot.dutch_decline_per_minute_cents, 0))::BIGINT;

  IF v_lot.dutch_floor_cents IS NOT NULL THEN
    v_price := GREATEST(v_price, v_lot.dutch_floor_cents);
  END IF;

  RETURN v_price;
END;
$$;

GRANT EXECUTE ON FUNCTION compute_dutch_current_price(UUID, TIMESTAMPTZ) TO authenticated;
