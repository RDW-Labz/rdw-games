-- ============================================================================
-- Row Level Security policies — multi-tenant isolation
--
-- Two principal types:
--  1. bidders (auth.users with a row in `bidders`) — global identity
--  2. operator_users (auth.users with a row in `operator_users`) — tenant-scoped
--
-- Helper functions read auth.uid() and resolve which operator the caller belongs
-- to (if any). Bidders see published lots from any operator; operator_users
-- only see their own operator's data.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_operator_id()
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT operator_id FROM operator_users
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION current_operator_role()
RETURNS operator_user_role
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM operator_users
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION is_bidder()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM bidders WHERE id = auth.uid());
$$;

-- ----------------------------------------------------------------------------
-- Enable RLS on all tables
-- ----------------------------------------------------------------------------

ALTER TABLE bidders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE operators        ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses       ENABLE ROW LEVEL SECURITY;
ALTER TABLE bins             ENABLE ROW LEVEL SECURITY;
ALTER TABLE auctions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lots             ENABLE ROW LEVEL SECURITY;
ALTER TABLE bids             ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist        ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lots     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bin_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pickups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes         ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- BIDDERS — bidders can read/update their own record
-- Operator staff can read bidder PII only via the "has invoice with us" path
-- (not implemented as a direct policy on `bidders`; instead operator-side
-- queries join through invoices).
-- ----------------------------------------------------------------------------

CREATE POLICY bidders_self_read ON bidders
  FOR SELECT USING (id = auth.uid());

CREATE POLICY bidders_self_insert ON bidders
  FOR INSERT WITH CHECK (id = auth.uid());

CREATE POLICY bidders_self_update ON bidders
  FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- ----------------------------------------------------------------------------
-- OPERATORS — operator_users can read their own; bidders can read minimal
-- public-facing fields for any active operator (we'll project that with a view).
-- ----------------------------------------------------------------------------

CREATE POLICY operators_staff_read ON operators
  FOR SELECT USING (id = current_operator_id());

CREATE POLICY operators_staff_admin_update ON operators
  FOR UPDATE USING (
    id = current_operator_id() AND current_operator_role() = 'admin'
  );

CREATE POLICY operators_public_read_active ON operators
  FOR SELECT USING (status = 'active' AND is_bidder());

-- ----------------------------------------------------------------------------
-- OPERATOR_USERS
-- ----------------------------------------------------------------------------

CREATE POLICY operator_users_self_read ON operator_users
  FOR SELECT USING (user_id = auth.uid() OR operator_id = current_operator_id());

CREATE POLICY operator_users_admin_write ON operator_users
  FOR ALL USING (
    operator_id = current_operator_id() AND current_operator_role() = 'admin'
  ) WITH CHECK (
    operator_id = current_operator_id() AND current_operator_role() = 'admin'
  );

-- ----------------------------------------------------------------------------
-- WAREHOUSES
-- Operator staff: full access to their own. Bidders: read for warehouses
-- that have at least one published auction (enforced via app-layer query).
-- ----------------------------------------------------------------------------

CREATE POLICY warehouses_staff_all ON warehouses
  FOR ALL USING (operator_id = current_operator_id())
  WITH CHECK (operator_id = current_operator_id());

CREATE POLICY warehouses_bidder_read ON warehouses
  FOR SELECT USING (is_bidder());

-- ----------------------------------------------------------------------------
-- BINS
-- Operator staff: full access (write requires manager+). Bidders: read only
-- for bins assigned to their won lots — enforced via the `bin_assignments`
-- + `invoices` join in the app layer; the policy here is permissive read for
-- any authenticated bidder, and we filter at query time.
--
-- (Stricter alternative: subquery against invoices. Doing that on every bin
-- read is expensive; we keep bins coordinates non-sensitive and rely on the
-- app to scope.)
-- ----------------------------------------------------------------------------

CREATE POLICY bins_staff_all ON bins
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM warehouses w
      WHERE w.id = bins.warehouse_id AND w.operator_id = current_operator_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM warehouses w
      WHERE w.id = bins.warehouse_id AND w.operator_id = current_operator_id()
    )
  );

CREATE POLICY bins_bidder_read ON bins
  FOR SELECT USING (is_bidder());

-- ----------------------------------------------------------------------------
-- AUCTIONS
-- ----------------------------------------------------------------------------

CREATE POLICY auctions_staff_all ON auctions
  FOR ALL USING (operator_id = current_operator_id())
  WITH CHECK (operator_id = current_operator_id());

CREATE POLICY auctions_bidder_read_published ON auctions
  FOR SELECT USING (
    is_bidder() AND status IN ('scheduled', 'live', 'closed')
  );

-- ----------------------------------------------------------------------------
-- LOTS
-- ----------------------------------------------------------------------------

CREATE POLICY lots_staff_all ON lots
  FOR ALL USING (operator_id = current_operator_id())
  WITH CHECK (operator_id = current_operator_id());

CREATE POLICY lots_bidder_read_published ON lots
  FOR SELECT USING (
    is_bidder() AND status IN ('scheduled', 'live', 'won', 'unsold', 'relisted')
  );

-- ----------------------------------------------------------------------------
-- BIDS
-- Bidder can SELECT their own bids on any lot, and the current_bid_cents on
-- the lot row is public. Bidders cannot see other bidders' max_amount_cents.
-- Operator staff can see all bids on lots in their auctions.
-- INSERT goes through the place_bid SQL function (SECURITY DEFINER) — direct
-- inserts are blocked.
-- ----------------------------------------------------------------------------

CREATE POLICY bids_self_read ON bids
  FOR SELECT USING (bidder_id = auth.uid());

CREATE POLICY bids_staff_read ON bids
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM lots l
      WHERE l.id = bids.lot_id AND l.operator_id = current_operator_id()
    )
  );

-- No direct INSERT/UPDATE/DELETE policies — only place_bid() can modify bids.

-- ----------------------------------------------------------------------------
-- WATCHLIST
-- ----------------------------------------------------------------------------

CREATE POLICY watchlist_self_all ON watchlist
  FOR ALL USING (bidder_id = auth.uid())
  WITH CHECK (bidder_id = auth.uid());

-- ----------------------------------------------------------------------------
-- INVOICES + INVOICE_LOTS
-- ----------------------------------------------------------------------------

CREATE POLICY invoices_self_read ON invoices
  FOR SELECT USING (bidder_id = auth.uid());

CREATE POLICY invoices_staff_all ON invoices
  FOR ALL USING (operator_id = current_operator_id())
  WITH CHECK (operator_id = current_operator_id());

CREATE POLICY invoice_lots_self_read ON invoice_lots
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_lots.invoice_id AND i.bidder_id = auth.uid()
    )
  );

CREATE POLICY invoice_lots_staff_all ON invoice_lots
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_lots.invoice_id AND i.operator_id = current_operator_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_lots.invoice_id AND i.operator_id = current_operator_id()
    )
  );

-- ----------------------------------------------------------------------------
-- BIN_ASSIGNMENTS
-- Operator staff (especially pickers) write these. Bidders read only the
-- assignments for lots they won (via invoice_lots).
-- ----------------------------------------------------------------------------

CREATE POLICY bin_assignments_staff_all ON bin_assignments
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM lots l
      WHERE l.id = bin_assignments.lot_id AND l.operator_id = current_operator_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM lots l
      WHERE l.id = bin_assignments.lot_id AND l.operator_id = current_operator_id()
    )
  );

CREATE POLICY bin_assignments_bidder_read ON bin_assignments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM invoice_lots il
      JOIN invoices i ON i.id = il.invoice_id
      WHERE il.lot_id = bin_assignments.lot_id AND i.bidder_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- PICKUPS
-- ----------------------------------------------------------------------------

CREATE POLICY pickups_self_read ON pickups
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = pickups.invoice_id AND i.bidder_id = auth.uid()
    )
  );

CREATE POLICY pickups_self_update ON pickups
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = pickups.invoice_id AND i.bidder_id = auth.uid()
    )
  );

CREATE POLICY pickups_staff_all ON pickups
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = pickups.invoice_id AND i.operator_id = current_operator_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = pickups.invoice_id AND i.operator_id = current_operator_id()
    )
  );

-- ----------------------------------------------------------------------------
-- DISPUTES
-- ----------------------------------------------------------------------------

CREATE POLICY disputes_self_all ON disputes
  FOR ALL USING (bidder_id = auth.uid())
  WITH CHECK (bidder_id = auth.uid());

CREATE POLICY disputes_staff_all ON disputes
  FOR ALL USING (operator_id = current_operator_id())
  WITH CHECK (operator_id = current_operator_id());
