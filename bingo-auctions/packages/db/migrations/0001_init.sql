-- ============================================================================
-- Auction Platform — Initial Schema (v1)
--
-- Multi-tenant SaaS auction marketplace. Tenant root = operators.
-- Bidders are global (not tenant-scoped) — one identity across all operators.
--
-- Naming: snake_case. Money in cents (BIGINT). Timestamps as TIMESTAMPTZ.
-- ============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE operator_status AS ENUM ('pending', 'active', 'suspended');
CREATE TYPE operator_user_role AS ENUM ('admin', 'manager', 'picker');
CREATE TYPE auction_status AS ENUM ('draft', 'scheduled', 'live', 'closed', 'canceled');
CREATE TYPE lot_status AS ENUM ('draft', 'scheduled', 'live', 'won', 'unsold', 'canceled', 'relisted');
CREATE TYPE lot_condition AS ENUM ('appears_new', 'open_box', 'good', 'as_is');
CREATE TYPE invoice_status AS ENUM ('pending', 'paid', 'refunded', 'partially_refunded', 'canceled');
CREATE TYPE pickup_status AS ENUM ('pending', 'scheduled', 'completed', 'no_show', 'forfeited');
CREATE TYPE bin_assignment_status AS ENUM ('staged', 'picked_up', 'returned_to_floor');
CREATE TYPE dispute_status AS ENUM ('open', 'resolved', 'denied');

-- ============================================================================
-- BIDDERS (global — NOT tenant-scoped)
-- One bidder identity works across all operators.
-- ============================================================================

CREATE TABLE bidders (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  phone TEXT,
  stripe_customer_id TEXT UNIQUE,
  identity_verified_at TIMESTAMPTZ,
  total_lifetime_wins INTEGER NOT NULL DEFAULT 0,
  no_show_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bidders_email_idx ON bidders (email);

-- ============================================================================
-- OPERATORS (tenant root)
-- ============================================================================

CREATE TABLE operators (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug TEXT NOT NULL UNIQUE,
  business_name TEXT NOT NULL,
  legal_name TEXT,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  status operator_status NOT NULL DEFAULT 'pending',
  -- Stripe Connect
  stripe_account_id TEXT UNIQUE,
  stripe_onboarding_complete BOOLEAN NOT NULL DEFAULT false,
  -- Branding
  logo_url TEXT,
  brand_color TEXT,
  -- Pricing on the platform (the SaaS hybrid model)
  monthly_subscription_cents INTEGER NOT NULL DEFAULT 9900,
  application_fee_bps INTEGER NOT NULL DEFAULT 200, -- 2.00% of GMV in basis points
  -- Auction defaults (operators can override per-auction)
  default_buyer_premium_bps INTEGER NOT NULL DEFAULT 1500, -- 15%
  default_soft_close_minutes INTEGER NOT NULL DEFAULT 3,
  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX operators_slug_idx ON operators (slug);
CREATE INDEX operators_status_idx ON operators (status);

-- ============================================================================
-- OPERATOR_USERS (staff: admins, managers, pickers)
-- Linked to auth.users; an auth user can only be staff for one operator.
-- ============================================================================

CREATE TABLE operator_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role operator_user_role NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX operator_users_operator_idx ON operator_users (operator_id);
CREATE INDEX operator_users_user_idx ON operator_users (user_id);

-- ============================================================================
-- WAREHOUSES (per operator)
-- ============================================================================

CREATE TABLE warehouses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL, -- US-only at launch
  postal_code TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  -- Floor plan
  floor_plan_url TEXT,
  floor_plan_width_px INTEGER, -- pixel dimensions of the uploaded floor plan
  floor_plan_height_px INTEGER,
  -- Pickup hours stored as JSONB { "mon": [{ "open": "10:00", "close": "18:00" }] }
  pickup_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX warehouses_operator_idx ON warehouses (operator_id);

-- ============================================================================
-- BINS (per warehouse — physical pickup locations)
-- ABLP code: aisle-bay-level-position. (x, y) in pixel coordinates on the
-- warehouse's floor plan PNG.
-- ============================================================================

CREATE TABLE bins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  code TEXT NOT NULL, -- e.g., "A-02-3-04"
  aisle TEXT NOT NULL,
  bay TEXT,
  level INTEGER,
  position INTEGER,
  -- Coordinates on the warehouse floor plan
  x_px INTEGER NOT NULL,
  y_px INTEGER NOT NULL,
  -- QR — UUID-based, printed on the physical bin
  qr_token UUID NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, code)
);

CREATE INDEX bins_warehouse_idx ON bins (warehouse_id);
CREATE INDEX bins_qr_idx ON bins (qr_token);

-- ============================================================================
-- AUCTIONS (a scheduled batch of lots from one warehouse)
-- ============================================================================

CREATE TABLE auctions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT,
  status auction_status NOT NULL DEFAULT 'draft',
  -- Timing
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL, -- the "first" lot close — actual lot close_at is per-lot
  soft_close_minutes INTEGER NOT NULL DEFAULT 3,
  -- Pickup window
  pickup_starts_at TIMESTAMPTZ NOT NULL,
  pickup_ends_at TIMESTAMPTZ NOT NULL,
  -- Fees
  buyer_premium_bps INTEGER NOT NULL DEFAULT 1500,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT auction_ends_after_starts CHECK (ends_at > starts_at),
  CONSTRAINT pickup_after_ends CHECK (pickup_starts_at >= ends_at)
);

CREATE INDEX auctions_operator_idx ON auctions (operator_id);
CREATE INDEX auctions_status_idx ON auctions (status);
CREATE INDEX auctions_ends_at_idx ON auctions (ends_at);

-- ============================================================================
-- LOTS (individual items being auctioned)
-- ============================================================================

CREATE TABLE lots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  -- Item details
  lot_number INTEGER NOT NULL, -- per-auction sequential
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  condition lot_condition NOT NULL DEFAULT 'good',
  msrp_cents BIGINT,
  starting_bid_cents BIGINT NOT NULL DEFAULT 100,
  -- Photos (array of URLs in Supabase Storage)
  photo_urls TEXT[] NOT NULL DEFAULT '{}',
  -- Bidding state
  status lot_status NOT NULL DEFAULT 'draft',
  current_bid_cents BIGINT,
  current_bid_id UUID,
  bid_count INTEGER NOT NULL DEFAULT 0,
  -- Timing — close_at can extend during soft-close
  close_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  -- Winner (denormalized for query speed; canonical source is the winning bid)
  winner_bidder_id UUID REFERENCES bidders(id),
  -- Search
  search_tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'C')
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (auction_id, lot_number)
);

CREATE INDEX lots_operator_idx ON lots (operator_id);
CREATE INDEX lots_auction_idx ON lots (auction_id);
CREATE INDEX lots_warehouse_idx ON lots (warehouse_id);
CREATE INDEX lots_status_idx ON lots (status);
CREATE INDEX lots_close_at_idx ON lots (close_at) WHERE status IN ('scheduled', 'live');
CREATE INDEX lots_winner_idx ON lots (winner_bidder_id) WHERE winner_bidder_id IS NOT NULL;
CREATE INDEX lots_search_idx ON lots USING GIN (search_tsv);
CREATE INDEX lots_title_trgm_idx ON lots USING GIN (title gin_trgm_ops);

-- ============================================================================
-- BIDS
-- max_bid_cents = the bidder's true ceiling; current_bid_cents on the lot is
-- what the proxy logic resolved to. We keep every bid, including auto-bids
-- generated by the proxy mechanism (with is_auto = true).
-- ============================================================================

CREATE TABLE bids (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  bidder_id UUID NOT NULL REFERENCES bidders(id) ON DELETE RESTRICT,
  amount_cents BIGINT NOT NULL,
  max_amount_cents BIGINT NOT NULL, -- proxy ceiling; >= amount_cents
  is_auto BOOLEAN NOT NULL DEFAULT false,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bid_max_gte_amount CHECK (max_amount_cents >= amount_cents)
);

CREATE INDEX bids_lot_idx ON bids (lot_id, placed_at DESC);
CREATE INDEX bids_bidder_idx ON bids (bidder_id, placed_at DESC);

-- After the table exists we can wire the FK on lots.current_bid_id
ALTER TABLE lots ADD CONSTRAINT lots_current_bid_fk
  FOREIGN KEY (current_bid_id) REFERENCES bids(id) ON DELETE SET NULL;

-- ============================================================================
-- WATCHLIST (bidder follows a lot)
-- ============================================================================

CREATE TABLE watchlist (
  bidder_id UUID NOT NULL REFERENCES bidders(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bidder_id, lot_id)
);

CREATE INDEX watchlist_lot_idx ON watchlist (lot_id);

-- ============================================================================
-- INVOICES (one per bidder per auction, generated when bidder wins anything)
-- ============================================================================

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE RESTRICT,
  bidder_id UUID NOT NULL REFERENCES bidders(id) ON DELETE RESTRICT,
  status invoice_status NOT NULL DEFAULT 'pending',
  -- Amounts in cents
  subtotal_cents BIGINT NOT NULL DEFAULT 0,         -- sum of winning bids
  buyer_premium_cents BIGINT NOT NULL DEFAULT 0,
  tax_cents BIGINT NOT NULL DEFAULT 0,
  total_cents BIGINT NOT NULL DEFAULT 0,
  -- SaaS fee tracking (informational; actual split happens at Stripe)
  application_fee_cents BIGINT NOT NULL DEFAULT 0,
  -- Stripe
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_charge_id TEXT,
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (auction_id, bidder_id)
);

CREATE INDEX invoices_operator_idx ON invoices (operator_id);
CREATE INDEX invoices_bidder_idx ON invoices (bidder_id);
CREATE INDEX invoices_status_idx ON invoices (status);

-- An invoice contains many lots (the bidder's wins from this auction)
CREATE TABLE invoice_lots (
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE RESTRICT,
  winning_bid_cents BIGINT NOT NULL,
  PRIMARY KEY (invoice_id, lot_id)
);

CREATE INDEX invoice_lots_lot_idx ON invoice_lots (lot_id);

-- ============================================================================
-- BIN_ASSIGNMENTS (lot ↔ bin, with audit trail)
-- One row per assignment event. Most recent row is "current location."
-- ============================================================================

CREATE TABLE bin_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  bin_id UUID NOT NULL REFERENCES bins(id) ON DELETE RESTRICT,
  operator_user_id UUID REFERENCES operator_users(id) ON DELETE SET NULL,
  status bin_assignment_status NOT NULL DEFAULT 'staged',
  staging_photo_url TEXT,
  notes TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_up_at TIMESTAMPTZ
);

CREATE INDEX bin_assignments_lot_idx ON bin_assignments (lot_id, assigned_at DESC);
CREATE INDEX bin_assignments_bin_idx ON bin_assignments (bin_id, assigned_at DESC);

-- ============================================================================
-- PICKUPS (bidder's pickup appointment for an invoice)
-- ============================================================================

CREATE TABLE pickups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  status pickup_status NOT NULL DEFAULT 'pending',
  scheduled_at TIMESTAMPTZ,
  checked_in_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  bidder_check_in_token UUID NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX pickups_invoice_idx ON pickups (invoice_id);
CREATE INDEX pickups_status_idx ON pickups (status);

-- ============================================================================
-- DISPUTES (condition disputes raised at pickup)
-- ============================================================================

CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE RESTRICT,
  bidder_id UUID NOT NULL REFERENCES bidders(id) ON DELETE RESTRICT,
  status dispute_status NOT NULL DEFAULT 'open',
  reason TEXT NOT NULL,
  bidder_photo_urls TEXT[] NOT NULL DEFAULT '{}',
  resolution_notes TEXT,
  refund_cents BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX disputes_operator_idx ON disputes (operator_id);
CREATE INDEX disputes_status_idx ON disputes (status);

-- ============================================================================
-- updated_at trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'bidders','operators','operator_users','warehouses','bins','auctions',
    'lots','invoices','pickups'
  ])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t
    );
  END LOOP;
END $$;
