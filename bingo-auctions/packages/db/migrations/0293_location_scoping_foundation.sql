-- ============================================================================
-- Migration 0293 — make LOCATION a first-class dimension
--
-- Context: docs/audits/2026-07-27-multi-location-audit.md
--
-- BinGo was built operator-scoped with warehouse as an optional attribute.
-- That was invisible with one warehouse. Dodge City (KS) was created
-- 2026-07-27 as the second, and Harrison is in Arkansas — a different state —
-- so several things that were "fine because there was only one of them" are now
-- wrong.
--
-- Every column here is NULLABLE with a fall-back to the existing operator-level
-- value, so this migration changes NO behaviour on its own. Harrison keeps
-- charging exactly what it charges today. The per-warehouse values only take
-- effect once someone sets them.
--
-- What this covers (audit items 2, 3, 6, 9 + the pickup-session column):
--   1. warehouses.tax_rate_bps        — per-location sales tax (P0, compliance)
--   2. warehouses.square_location_id  — per-location Square mapping (P0)
--   3. operator_users.warehouse_id    — staff home location (P1)
--      workers.warehouse_id
--   4. loads.warehouse_id             — which building a truckload landed at (P2)
--   5. pickup_sessions.warehouse_id   — stop the cross-warehouse pass (P0)
--   6. build_invoices_for_auction     — resolve tax at the AUCTION'S warehouse
--
-- NOT covered here (needs app work, tracked in the audit): the field-mobile
-- selector, the global web warehouse context, the responsive console, and
-- splitting pickup sessions per warehouse in the session loader.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Per-warehouse sales tax
--
-- Harrison AR and Dodge City KS are different states: separate registration,
-- separate nexus, separate filing, different rates. One flat operator rate
-- (currently 950 = 9.50%, correct for Harrison) cannot describe both.
--
-- NULL = "use the operator's rate", which is exactly today's behaviour for
-- every existing warehouse. Setting it opts that one location out.
--
-- The 0214 header predicted this verbatim: "A future multi-warehouse operator
-- needs per-warehouse rates."
-- ---------------------------------------------------------------------------
ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS tax_rate_bps INT
    CHECK (tax_rate_bps IS NULL OR tax_rate_bps BETWEEN 0 AND 2000);

COMMENT ON COLUMN public.warehouses.tax_rate_bps IS
  '0293: combined sales-tax rate in basis points for THIS location (950 = '
  '9.50%). NULL = inherit operators.tax_rate_bps. Tax situs for in-person '
  'pickup is the warehouse, so this is the correct axis once an operator '
  'spans states.';

-- ---------------------------------------------------------------------------
-- 2. Per-warehouse Square location
--
-- ONE Square account and ONE access token serve any number of locations — a
-- location is just an id passed per transaction. No second integration, no
-- second API key. But lib/square.ts pins a single global SQUARE_LOCATION_ID on
-- every CreatePayment (it calls this an INVARIANT), so without this column
-- every Kansas sale books to the Arkansas location and Square's own reporting,
-- deposit routing and location tax all misattribute it.
--
-- NULL = fall back to the SQUARE_LOCATION_ID env var, i.e. today's behaviour.
-- ---------------------------------------------------------------------------
ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS square_location_id TEXT;

COMMENT ON COLUMN public.warehouses.square_location_id IS
  '0293: Square location id for THIS warehouse (same Square account + access '
  'token as every other location — a location is per-transaction, not a '
  'separate integration). NULL = fall back to the SQUARE_LOCATION_ID env var.';

-- ---------------------------------------------------------------------------
-- 3. Staff home location
--
-- Neither operator_users nor workers had any warehouse, so a Dodge City PIN
-- works at Harrison and there is no per-location staff list or attribution.
--
-- NULL = "all locations", which preserves today's behaviour for every existing
-- row and stays correct for owners/admins who genuinely span both.
-- ---------------------------------------------------------------------------
ALTER TABLE public.operator_users
  ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES public.warehouses(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.operator_users.warehouse_id IS
  '0293: home warehouse for this staff member. NULL = all locations (owners, '
  'admins, and every pre-0293 row).';

ALTER TABLE public.workers
  ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES public.warehouses(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.workers.warehouse_id IS
  '0293: home warehouse for this PIN worker. NULL = all locations.';

CREATE INDEX IF NOT EXISTS operator_users_warehouse_idx
  ON public.operator_users (warehouse_id) WHERE warehouse_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workers_warehouse_idx
  ON public.workers (warehouse_id) WHERE warehouse_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Loads land at a building
-- ---------------------------------------------------------------------------
ALTER TABLE public.loads
  ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES public.warehouses(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.loads.warehouse_id IS
  '0293: warehouse this load was received at. NULL = unknown / pre-0293.';

-- ---------------------------------------------------------------------------
-- 5. Pickup sessions are per-location
--
-- pickup_sessions had no warehouse and loadSessionContents() has zero warehouse
-- references — it serpentine-orders the walk list by AISLE ALONE. A bidder who
-- won at both locations would get one pass interleaving "Aisle 3" in Harrison
-- with "Aisle 3" in Dodge City, and one QR that opens everything at either
-- counter. Harrison and Dodge City are ~400 miles apart.
--
-- The column is added here; the loader change lands with the app work. NULL =
-- a legacy all-locations session, which is what every existing row is.
--
-- NOTE the partial unique index below REPLACES the old one-open-session-per-
-- bidder rule with one-open-session-per-(bidder, warehouse). The legacy
-- NULL-warehouse sessions keep their own single-row slot because NULL is not
-- equal to itself in a unique index — so a bidder can hold one legacy session
-- plus one per warehouse without collision.
-- ---------------------------------------------------------------------------
ALTER TABLE public.pickup_sessions
  ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES public.warehouses(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.pickup_sessions.warehouse_id IS
  '0293: the location this pass is for. NULL = legacy all-locations session '
  '(every pre-0293 row). One open session per (bidder, warehouse).';

CREATE UNIQUE INDEX IF NOT EXISTS pickup_sessions_one_open_per_bidder_warehouse
  ON public.pickup_sessions (bidder_id, warehouse_id)
  WHERE status = 'open' AND warehouse_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. Resolve tax at the auction's warehouse
--
-- Full replacement of the 0233 definition (verified byte-for-byte as the live
-- body on prod 2026-07-27 — md5 98870adc…, 3,806 chars, has the v_exempt
-- lookup, no warehouse reference). The ONLY changes:
--
--   • v_auction now also selects warehouse_id (auctions.warehouse_id is NOT
--     NULL, so this is always present).
--   • v_tax_bps resolves COALESCE(warehouse.tax_rate_bps, operator.tax_rate_bps)
--     and the v_tax CASE uses it.
--
-- Tax situs for in-person pickup is where the buyer takes possession, which is
-- the auction's warehouse — not the operator's HQ. With every warehouse's
-- tax_rate_bps still NULL this computes an identical result to today.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.build_invoices_for_auction(p_auction_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auction record;
  v_operator record;
  v_bidder record;
  v_invoice_id uuid;
  v_buyer_premium int;
  v_exempt boolean;
  v_tax int;
  v_tax_bps int;
  v_total int;
  v_app_fee int;
  v_count int := 0;
BEGIN
  -- 0293: warehouse_id added — it is the tax situs for in-person pickup.
  SELECT id, buyer_premium_bps, operator_id, warehouse_id
  INTO v_auction
  FROM public.auctions
  WHERE id = p_auction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'auction_not_found: %', p_auction_id;
  END IF;

  SELECT id, application_fee_bps, collect_sales_tax, tax_rate_bps
  INTO v_operator
  FROM public.operators
  WHERE id = v_auction.operator_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator_not_found: %', v_auction.operator_id;
  END IF;

  -- 0293: per-location rate, falling back to the operator's. Resolved ONCE per
  -- auction (every lot in an auction is at the same warehouse by construction —
  -- assign_lots_to_auction enforces it).
  SELECT COALESCE(w.tax_rate_bps, v_operator.tax_rate_bps, 0)
    INTO v_tax_bps
  FROM public.warehouses w
  WHERE w.id = v_auction.warehouse_id;
  v_tax_bps := COALESCE(v_tax_bps, v_operator.tax_rate_bps, 0);

  FOR v_bidder IN
    SELECT winner_bidder_id,
           SUM(current_bid_cents)::int AS subtotal
    FROM public.lots
    WHERE auction_id = p_auction_id
      AND status = 'won'
      AND winner_bidder_id IS NOT NULL
    GROUP BY winner_bidder_id
  LOOP
    v_buyer_premium := ROUND(v_bidder.subtotal::numeric * v_auction.buyer_premium_bps / 10000.0)::int;

    -- 0233: approved resale-certificate holders buy tax-free for resale.
    SELECT COALESCE(b.tax_exempt, false) INTO v_exempt
    FROM public.bidders b
    WHERE b.id = v_bidder.winner_bidder_id;

    -- 0214: flat sales tax on the full taxable price (subtotal + premium),
    -- gated on the operator's collect_sales_tax flag AND (0233) the
    -- bidder's exemption. 0293: rate now resolved per warehouse.
    v_tax := CASE
      WHEN COALESCE(v_operator.collect_sales_tax, false) AND NOT COALESCE(v_exempt, false)
        THEN ROUND((v_bidder.subtotal + v_buyer_premium)::numeric
                   * v_tax_bps / 10000.0)::int
      ELSE 0
    END;
    v_total := v_bidder.subtotal + v_buyer_premium + v_tax;
    v_app_fee := ROUND((v_bidder.subtotal + v_buyer_premium)::numeric * v_operator.application_fee_bps / 10000.0)::int;

    INSERT INTO public.invoices (
      operator_id, auction_id, bidder_id, status,
      subtotal_cents, buyer_premium_cents, tax_cents, total_cents, application_fee_cents
    ) VALUES (
      v_auction.operator_id, p_auction_id, v_bidder.winner_bidder_id, 'pending',
      v_bidder.subtotal, v_buyer_premium, v_tax, v_total, v_app_fee
    )
    ON CONFLICT (auction_id, bidder_id) DO UPDATE
      SET subtotal_cents = EXCLUDED.subtotal_cents,
          buyer_premium_cents = EXCLUDED.buyer_premium_cents,
          tax_cents = EXCLUDED.tax_cents,
          total_cents = EXCLUDED.total_cents,
          application_fee_cents = EXCLUDED.application_fee_cents
      WHERE public.invoices.status = 'pending'
    RETURNING id INTO v_invoice_id;

    -- If the upsert was a no-op (status != 'pending'), the RETURNING is NULL.
    -- Re-fetch so we can still rebuild invoice_lots for any pending invoice
    -- that just got refreshed.
    IF v_invoice_id IS NULL THEN
      SELECT id INTO v_invoice_id
      FROM public.invoices
      WHERE auction_id = p_auction_id AND bidder_id = v_bidder.winner_bidder_id;
    END IF;

    -- Only rebuild invoice_lots for a pending invoice. Paid/refunded
    -- invoices keep their historical line items.
    IF EXISTS (
      SELECT 1 FROM public.invoices
      WHERE id = v_invoice_id AND status = 'pending'
    ) THEN
      DELETE FROM public.invoice_lots WHERE invoice_id = v_invoice_id;
      INSERT INTO public.invoice_lots (invoice_id, lot_id, winning_bid_cents)
      SELECT v_invoice_id, l.id, l.current_bid_cents
      FROM public.lots l
      WHERE l.auction_id = p_auction_id
        AND l.status = 'won'
        AND l.winner_bidder_id = v_bidder.winner_bidder_id;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. warehouse_square_location(warehouse_id) — read side for lib/square.ts
--
-- Kept as a function so the app has one place to ask "which Square location
-- does this warehouse charge against?" and the NULL-means-env-var rule lives in
-- exactly one spot. Returns NULL when unmapped; the caller supplies the env
-- fallback (the env var is not visible to Postgres).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.warehouse_square_location(p_warehouse_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NULLIF(TRIM(w.square_location_id), '')
  FROM public.warehouses w
  WHERE w.id = p_warehouse_id;
$$;

REVOKE ALL ON FUNCTION public.warehouse_square_location(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.warehouse_square_location(UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. invoice_warehouse(invoice_id) — which location does an invoice belong to?
--
-- Invoices carry auction_id, and auctions carry warehouse_id, so this is a
-- lookup rather than new state. The charge path needs it to pick the Square
-- location, and the pickup pass needs it to scope a session.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invoice_warehouse(p_invoice_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.warehouse_id
  FROM public.invoices i
  JOIN public.auctions a ON a.id = i.auction_id
  WHERE i.id = p_invoice_id;
$$;

REVOKE ALL ON FUNCTION public.invoice_warehouse(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invoice_warehouse(UUID) TO authenticated, service_role;

COMMIT;
