-- ============================================================================
-- Migration 0133: RLS initPlan subquery wrap — performance optimization
--
-- Tracked in audit DB-4 (Top-12 #1).
--
-- WHAT THIS DOES
-- --------------
-- Rewrites every RLS policy that calls the stable helper functions
-- current_operator_id(), current_operator_role(), is_bidder(), and
-- auth.uid() so that those calls are wrapped in (SELECT ...) subqueries:
--
--   BEFORE:  USING (operator_id = current_operator_id())
--   AFTER:   USING (operator_id = (SELECT current_operator_id()))
--
-- WHY THIS MATTERS
-- ----------------
-- PostgreSQL evaluates a bare function call in an RLS USING/WITH CHECK
-- expression once per row. For a table with 100 k lots the planner calls
-- current_operator_id() 100 k times — even though the result is identical
-- for every row of the same query. Wrapping in (SELECT fn()) tells the
-- planner to evaluate the subquery exactly ONCE per query as an "initPlan"
-- and cache the result. This is the single highest-leverage performance fix
-- available in the codebase — it affects every query on every multi-tenant
-- table.
--
-- SEMANTICS ARE IDENTICAL
-- -----------------------
-- The (SELECT fn()) wrapper produces the same value as fn() for
-- STABLE/SECURITY DEFINER functions that take no arguments. Row-level
-- access control is unchanged — the same rows are visible, the same
-- rows pass WITH CHECK. Only the number of function evaluations changes.
--
-- HELPER FUNCTIONS ARE NOT MODIFIED
-- ----------------------------------
-- This migration does NOT redefine current_operator_id(),
-- current_operator_role(), is_bidder(), or any other helper. Those
-- definitions remain in 0002_rls.sql. Only the RLS policy expressions
-- that reference them are rewritten.
--
-- SUPERSESSION HANDLING
-- ---------------------
-- Where a later migration (0028, 0091, 0094, 0098, etc.) already dropped
-- and recreated a policy from an earlier file, only the LAST surviving
-- definition is emitted here. Dropped-and-never-recreated policies
-- (pickups_self_update, operator_users_self_update, lots_staff_all,
-- auctions_staff_all, warehouses_staff_all, invoices_staff_all,
-- disputes_self_all, disputes_staff_all, bidder_subs_operator_read
-- from 0002/0013) are intentionally absent.
--
-- REFERENCE
-- ---------
-- Supabase RLS performance guide:
--   https://supabase.com/docs/guides/database/postgres/row-level-security#use-functions
-- Audit document: docs/state/AUDIT-bugs-and-optimizations-2026-05-24.md §B DB-4
-- ============================================================================

BEGIN;

-- ============================================================================
-- Table: public.bidders — 3 policies
-- ============================================================================

DROP POLICY IF EXISTS bidders_self_read ON public.bidders;
CREATE POLICY bidders_self_read ON public.bidders
  FOR SELECT
  USING (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS bidders_self_insert ON public.bidders;
CREATE POLICY bidders_self_insert ON public.bidders
  FOR INSERT
  WITH CHECK (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS bidders_self_update ON public.bidders;
CREATE POLICY bidders_self_update ON public.bidders
  FOR UPDATE
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- ============================================================================
-- Table: public.operators — 3 policies
-- ============================================================================

DROP POLICY IF EXISTS operators_staff_read ON public.operators;
CREATE POLICY operators_staff_read ON public.operators
  FOR SELECT
  USING (id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS operators_staff_admin_update ON public.operators;
CREATE POLICY operators_staff_admin_update ON public.operators
  FOR UPDATE
  USING (
    id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) = 'admin'
  );

DROP POLICY IF EXISTS operators_public_read_active ON public.operators;
CREATE POLICY operators_public_read_active ON public.operators
  FOR SELECT
  USING (status = 'active' AND (SELECT is_bidder()));

-- ============================================================================
-- Table: public.operator_users — 2 policies
-- Note: operator_users_self_update was dropped by 0091 and replaced with
-- SECURITY DEFINER RPCs. operator_users_admin_write from 0002 was never
-- superseded. operator_users_self_read from 0002 was never superseded.
-- ============================================================================

DROP POLICY IF EXISTS operator_users_self_read ON public.operator_users;
CREATE POLICY operator_users_self_read ON public.operator_users
  FOR SELECT
  USING (
    user_id = (SELECT auth.uid())
    OR operator_id = (SELECT current_operator_id())
  );

DROP POLICY IF EXISTS operator_users_admin_write ON public.operator_users;
CREATE POLICY operator_users_admin_write ON public.operator_users
  FOR ALL
  USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) = 'admin'
  )
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) = 'admin'
  );

-- ============================================================================
-- Table: public.warehouses — 5 policies
-- Note: warehouses_staff_all (0002) was superseded by 0028 split.
--       warehouses_bidder_read (0002) was superseded by 0094 tightening.
-- ============================================================================

DROP POLICY IF EXISTS warehouses_staff_read ON public.warehouses;
CREATE POLICY warehouses_staff_read ON public.warehouses
  FOR SELECT
  USING (operator_id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS warehouses_staff_write ON public.warehouses;
CREATE POLICY warehouses_staff_write ON public.warehouses
  FOR INSERT
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS warehouses_staff_update ON public.warehouses;
CREATE POLICY warehouses_staff_update ON public.warehouses
  FOR UPDATE
  USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS warehouses_staff_delete ON public.warehouses;
CREATE POLICY warehouses_staff_delete ON public.warehouses
  FOR DELETE
  USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) = 'admin'
  );

-- warehouses_bidder_read: superseded by 0094 — uses bidder_has_warehouse_access()
-- which already wraps auth.uid() internally. The outer is_bidder() call needs
-- wrapping as well.
DROP POLICY IF EXISTS warehouses_bidder_read ON public.warehouses;
CREATE POLICY warehouses_bidder_read ON public.warehouses
  FOR SELECT
  USING (
    (SELECT is_bidder()) AND bidder_has_warehouse_access(id)
  );

-- ============================================================================
-- Table: public.bins — 3 policies
-- Note: bins_staff_all (0002) uses current_operator_id() inside EXISTS —
--       the inner call still benefits from wrapping.
--       bins_bidder_read (0002) was superseded by 0094 tightening.
-- ============================================================================

DROP POLICY IF EXISTS bins_staff_all ON public.bins;
CREATE POLICY bins_staff_all ON public.bins
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM warehouses w
      WHERE w.id = bins.warehouse_id
        AND w.operator_id = (SELECT current_operator_id())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM warehouses w
      WHERE w.id = bins.warehouse_id
        AND w.operator_id = (SELECT current_operator_id())
    )
  );

-- bins_bidder_read: superseded by 0094 — uses is_bidder() + bidder_has_warehouse_access()
DROP POLICY IF EXISTS bins_bidder_read ON public.bins;
CREATE POLICY bins_bidder_read ON public.bins
  FOR SELECT
  USING (
    (SELECT is_bidder()) AND bidder_has_warehouse_access(warehouse_id)
  );

-- ============================================================================
-- Table: public.auctions — 6 policies
-- Note: auctions_staff_all (0002) was superseded by 0028 split.
-- ============================================================================

DROP POLICY IF EXISTS auctions_staff_read ON public.auctions;
CREATE POLICY auctions_staff_read ON public.auctions
  FOR SELECT
  USING (operator_id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS auctions_staff_insert ON public.auctions;
CREATE POLICY auctions_staff_insert ON public.auctions
  FOR INSERT
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS auctions_staff_update ON public.auctions;
CREATE POLICY auctions_staff_update ON public.auctions
  FOR UPDATE
  USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS auctions_staff_delete ON public.auctions;
CREATE POLICY auctions_staff_delete ON public.auctions
  FOR DELETE
  USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) = 'admin'
  );

DROP POLICY IF EXISTS auctions_bidder_read_published ON public.auctions;
CREATE POLICY auctions_bidder_read_published ON public.auctions
  FOR SELECT
  USING (
    (SELECT is_bidder()) AND status IN ('scheduled', 'live', 'closed')
  );

-- ============================================================================
-- Table: public.lots — 7 policies
-- Note: lots_staff_all (0002) superseded by 0028 split.
--       lots_bidder_read_published: chain 0002 → 0008 → 0013 — use 0013 final.
-- ============================================================================

DROP POLICY IF EXISTS lots_staff_read ON public.lots;
CREATE POLICY lots_staff_read ON public.lots
  FOR SELECT
  USING (operator_id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS lots_staff_insert ON public.lots;
CREATE POLICY lots_staff_insert ON public.lots
  FOR INSERT
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS lots_staff_update ON public.lots;
CREATE POLICY lots_staff_update ON public.lots
  FOR UPDATE
  USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS lots_staff_delete ON public.lots;
CREATE POLICY lots_staff_delete ON public.lots
  FOR DELETE
  USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) = 'admin'
  );

-- lots_bidder_read_published: final version from 0013 (per-operator subscription scope).
-- is_bidder() and is_subscriber() both call auth.uid() internally; both need wrapping.
DROP POLICY IF EXISTS lots_bidder_read_published ON public.lots;
CREATE POLICY lots_bidder_read_published ON public.lots
  FOR SELECT
  USING (
    (SELECT is_bidder())
    AND status IN ('scheduled', 'live', 'won', 'unsold', 'relisted')
    AND (
      early_access_until IS NULL
      OR early_access_until <= now()
      OR is_subscriber(operator_id)
    )
  );

-- ============================================================================
-- Table: public.bids — 2 policies
-- ============================================================================

DROP POLICY IF EXISTS bids_self_read ON public.bids;
CREATE POLICY bids_self_read ON public.bids
  FOR SELECT
  USING (bidder_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS bids_staff_read ON public.bids;
CREATE POLICY bids_staff_read ON public.bids
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM lots l
      WHERE l.id = bids.lot_id
        AND l.operator_id = (SELECT current_operator_id())
    )
  );

-- ============================================================================
-- Table: public.watchlist — 1 policy
-- ============================================================================

DROP POLICY IF EXISTS watchlist_self_all ON public.watchlist;
CREATE POLICY watchlist_self_all ON public.watchlist
  FOR ALL
  USING (bidder_id = (SELECT auth.uid()))
  WITH CHECK (bidder_id = (SELECT auth.uid()));

-- ============================================================================
-- Table: public.invoices — 5 policies
-- Note: invoices_staff_all (0002) superseded by 0028 split.
-- ============================================================================

DROP POLICY IF EXISTS invoices_self_read ON public.invoices;
CREATE POLICY invoices_self_read ON public.invoices
  FOR SELECT
  USING (bidder_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS invoices_staff_read ON public.invoices;
CREATE POLICY invoices_staff_read ON public.invoices
  FOR SELECT
  USING (operator_id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS invoices_staff_update ON public.invoices;
CREATE POLICY invoices_staff_update ON public.invoices
  FOR UPDATE
  USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS invoices_staff_delete ON public.invoices;
CREATE POLICY invoices_staff_delete ON public.invoices
  FOR DELETE
  USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) = 'admin'
  );

-- ============================================================================
-- Table: public.invoice_lots — 2 policies
-- ============================================================================

DROP POLICY IF EXISTS invoice_lots_self_read ON public.invoice_lots;
CREATE POLICY invoice_lots_self_read ON public.invoice_lots
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_lots.invoice_id
        AND i.bidder_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS invoice_lots_staff_all ON public.invoice_lots;
CREATE POLICY invoice_lots_staff_all ON public.invoice_lots
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_lots.invoice_id
        AND i.operator_id = (SELECT current_operator_id())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_lots.invoice_id
        AND i.operator_id = (SELECT current_operator_id())
    )
  );

-- ============================================================================
-- Table: public.bin_assignments — 2 policies
-- ============================================================================

DROP POLICY IF EXISTS bin_assignments_staff_all ON public.bin_assignments;
CREATE POLICY bin_assignments_staff_all ON public.bin_assignments
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM lots l
      WHERE l.id = bin_assignments.lot_id
        AND l.operator_id = (SELECT current_operator_id())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM lots l
      WHERE l.id = bin_assignments.lot_id
        AND l.operator_id = (SELECT current_operator_id())
    )
  );

DROP POLICY IF EXISTS bin_assignments_bidder_read ON public.bin_assignments;
CREATE POLICY bin_assignments_bidder_read ON public.bin_assignments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM invoice_lots il
      JOIN invoices i ON i.id = il.invoice_id
      WHERE il.lot_id = bin_assignments.lot_id
        AND i.bidder_id = (SELECT auth.uid())
    )
  );

-- ============================================================================
-- Table: public.pickups — 3 policies
-- Note: pickups_self_update was dropped by 0028 and NOT recreated.
-- ============================================================================

DROP POLICY IF EXISTS pickups_self_read ON public.pickups;
CREATE POLICY pickups_self_read ON public.pickups
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = pickups.invoice_id
        AND i.bidder_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS pickups_staff_all ON public.pickups;
CREATE POLICY pickups_staff_all ON public.pickups
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = pickups.invoice_id
        AND i.operator_id = (SELECT current_operator_id())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = pickups.invoice_id
        AND i.operator_id = (SELECT current_operator_id())
    )
  );

-- ============================================================================
-- Table: public.disputes — 4 policies
-- Note: disputes_self_all (0002) + disputes_staff_all (0002) both superseded
--       by 0028 split. disputes_staff_write from 0028 omitted — it has no
--       helper calls (only column comparisons).
-- Note: disputes_self_read and disputes_self_insert from 0028 have auth.uid().
--       disputes_staff_read and disputes_staff_update from 0028 have helpers.
-- ============================================================================

DROP POLICY IF EXISTS disputes_self_read ON public.disputes;
CREATE POLICY disputes_self_read ON public.disputes
  FOR SELECT
  USING (bidder_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS disputes_self_insert ON public.disputes;
CREATE POLICY disputes_self_insert ON public.disputes
  FOR INSERT
  WITH CHECK (
    bidder_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = disputes.invoice_id
        AND i.bidder_id = (SELECT auth.uid())
        AND i.operator_id = disputes.operator_id
    )
  );

DROP POLICY IF EXISTS disputes_staff_read ON public.disputes;
CREATE POLICY disputes_staff_read ON public.disputes
  FOR SELECT
  USING (operator_id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS disputes_staff_update ON public.disputes;
CREATE POLICY disputes_staff_update ON public.disputes
  FOR UPDATE
  USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

-- ============================================================================
-- Table: public.bidder_subscriptions — 2 policies
-- Note: bidder_subs_operator_read (0013) superseded by tighter version (0028).
-- ============================================================================

DROP POLICY IF EXISTS bidder_subs_self_read ON public.bidder_subscriptions;
CREATE POLICY bidder_subs_self_read ON public.bidder_subscriptions
  FOR SELECT
  USING (bidder_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS bidder_subs_operator_read ON public.bidder_subscriptions;
CREATE POLICY bidder_subs_operator_read ON public.bidder_subscriptions
  FOR SELECT
  USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

-- ============================================================================
-- Table: public.operator_settlements — 1 policy
-- ============================================================================

DROP POLICY IF EXISTS operator_settlements_staff_read ON public.operator_settlements;
CREATE POLICY operator_settlements_staff_read ON public.operator_settlements
  FOR SELECT
  USING (operator_id = (SELECT current_operator_id()));

-- ============================================================================
-- Table: public.categories — 1 policy (USING (true) — no helpers, included
-- for DROP/CREATE idempotency completeness but no functional change)
-- ============================================================================
-- categories_public_read uses USING (true) — no helpers to wrap, skip.

-- ============================================================================
-- Table: public.category_aliases — 1 policy (USING (true) — no helpers)
-- ============================================================================
-- category_aliases_public_read uses USING (true) — skip.

-- ============================================================================
-- Table: public.saved_searches — 1 policy
-- ============================================================================

DROP POLICY IF EXISTS saved_searches_self_all ON public.saved_searches;
CREATE POLICY saved_searches_self_all ON public.saved_searches
  FOR ALL
  USING (bidder_id = (SELECT auth.uid()))
  WITH CHECK (bidder_id = (SELECT auth.uid()));

-- ============================================================================
-- Table: public.imports — 1 policy
-- ============================================================================

DROP POLICY IF EXISTS imports_staff_read ON public.imports;
CREATE POLICY imports_staff_read ON public.imports
  FOR SELECT
  USING (operator_id = (SELECT current_operator_id()));

-- ============================================================================
-- Table: public.product_lookups — 2 policies
-- Note: product_lookups_staff_write from 0027 was further superseded by
--       0028 (which dropped it entirely with no replacement, leaving only
--       product_lookups_authed_read for authenticated reads; all writes
--       are service-role).
-- ============================================================================

DROP POLICY IF EXISTS product_lookups_authed_read ON public.product_lookups;
CREATE POLICY product_lookups_authed_read ON public.product_lookups
  FOR SELECT
  USING ((SELECT auth.uid()) IS NOT NULL);

-- ============================================================================
-- Table: public.import_rows — 4 policies
-- ============================================================================

DROP POLICY IF EXISTS import_rows_staff_read ON public.import_rows;
CREATE POLICY import_rows_staff_read ON public.import_rows
  FOR SELECT
  USING (operator_id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS import_rows_staff_insert ON public.import_rows;
CREATE POLICY import_rows_staff_insert ON public.import_rows
  FOR INSERT
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS import_rows_staff_update ON public.import_rows;
CREATE POLICY import_rows_staff_update ON public.import_rows
  FOR UPDATE
  USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS import_rows_staff_delete ON public.import_rows;
CREATE POLICY import_rows_staff_delete ON public.import_rows
  FOR DELETE
  USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) = 'admin'
  );

-- ============================================================================
-- Table: public._schema_migrations — 1 policy
-- ============================================================================

DROP POLICY IF EXISTS schema_migrations_authed_read ON public._schema_migrations;
CREATE POLICY schema_migrations_authed_read ON public._schema_migrations
  FOR SELECT
  USING ((SELECT auth.uid()) IS NOT NULL);

-- ============================================================================
-- Table: public.competitor_lots — 1 policy
-- ============================================================================

DROP POLICY IF EXISTS competitor_lots_authed_read ON public.competitor_lots;
CREATE POLICY competitor_lots_authed_read ON public.competitor_lots
  FOR SELECT
  USING ((SELECT auth.uid()) IS NOT NULL);

-- ============================================================================
-- Table: public.ai_calls — 1 policy
-- ============================================================================

DROP POLICY IF EXISTS ai_calls_staff_read ON public.ai_calls;
CREATE POLICY ai_calls_staff_read ON public.ai_calls
  FOR SELECT
  USING (operator_id = (SELECT current_operator_id()));

-- ============================================================================
-- Table: public.payment_followups — 1 policy
-- ============================================================================

DROP POLICY IF EXISTS payment_followups_operator_read ON public.payment_followups;
CREATE POLICY payment_followups_operator_read ON public.payment_followups
  FOR SELECT
  USING (operator_id = (SELECT current_operator_id()));

-- ============================================================================
-- Table: public.operator_bidder_relations — 3 policies
-- ============================================================================

DROP POLICY IF EXISTS obr_staff_select ON public.operator_bidder_relations;
CREATE POLICY obr_staff_select ON public.operator_bidder_relations
  FOR SELECT
  USING (operator_id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS obr_staff_insert ON public.operator_bidder_relations;
CREATE POLICY obr_staff_insert ON public.operator_bidder_relations
  FOR INSERT
  WITH CHECK (operator_id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS obr_staff_update ON public.operator_bidder_relations;
CREATE POLICY obr_staff_update ON public.operator_bidder_relations
  FOR UPDATE
  USING (operator_id = (SELECT current_operator_id()))
  WITH CHECK (operator_id = (SELECT current_operator_id()));

-- ============================================================================
-- Table: public.policy_versions — 1 policy
-- (USING (published = TRUE) has no helper calls — no wrapping needed,
--  but included here for DROP/CREATE idempotency for completeness.)
-- ============================================================================
-- policy_versions: "public read published" uses USING (published = TRUE) — skip.

-- ============================================================================
-- Table: public.terms_acceptances — 1 policy
-- ============================================================================

DROP POLICY IF EXISTS "terms_acceptances: user reads own" ON public.terms_acceptances;
CREATE POLICY "terms_acceptances: user reads own"
  ON public.terms_acceptances
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- ============================================================================
-- Table: public.operator_policies — 4 policies
-- Note: "operator_policies: operator-admin update own" from 0088 was
--       superseded by 0091 (added WITH CHECK clause). Use the 0091 version.
-- ============================================================================

DROP POLICY IF EXISTS "operator_policies: public read published" ON public.operator_policies;
CREATE POLICY "operator_policies: public read published"
  ON public.operator_policies
  FOR SELECT
  USING (published = TRUE);

DROP POLICY IF EXISTS "operator_policies: operator-staff read own" ON public.operator_policies;
CREATE POLICY "operator_policies: operator-staff read own"
  ON public.operator_policies
  FOR SELECT
  USING (
    operator_id IN (
      SELECT operator_id FROM operator_users
      WHERE user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "operator_policies: operator-admin write own" ON public.operator_policies;
CREATE POLICY "operator_policies: operator-admin write own"
  ON public.operator_policies
  FOR INSERT
  WITH CHECK (
    operator_id IN (
      SELECT operator_id FROM operator_users
       WHERE user_id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

-- "operator_policies: operator-admin update own" — using 0091 version (added WITH CHECK)
DROP POLICY IF EXISTS "operator_policies: operator-admin update own" ON public.operator_policies;
CREATE POLICY "operator_policies: operator-admin update own"
  ON public.operator_policies
  FOR UPDATE
  USING (
    operator_id IN (
      SELECT operator_id FROM operator_users
       WHERE user_id = (SELECT auth.uid()) AND role = 'admin'
    )
  )
  WITH CHECK (
    operator_id IN (
      SELECT operator_id FROM operator_users
       WHERE user_id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

-- ============================================================================
-- Table: public.operator_policy_acceptances — 2 policies
-- ============================================================================

DROP POLICY IF EXISTS "operator_policy_acceptances: bidder reads own" ON public.operator_policy_acceptances;
CREATE POLICY "operator_policy_acceptances: bidder reads own"
  ON public.operator_policy_acceptances
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "operator_policy_acceptances: operator reads own" ON public.operator_policy_acceptances;
CREATE POLICY "operator_policy_acceptances: operator reads own"
  ON public.operator_policy_acceptances
  FOR SELECT
  USING (
    operator_id IN (
      SELECT operator_id FROM operator_users
      WHERE user_id = (SELECT auth.uid())
    )
  );

-- ============================================================================
-- Table: public.lot_status_history — 2 policies
-- ============================================================================

DROP POLICY IF EXISTS lot_status_history_operator_read ON public.lot_status_history;
CREATE POLICY lot_status_history_operator_read ON public.lot_status_history
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lots l
      WHERE l.id = lot_status_history.lot_id
        AND l.operator_id = (SELECT current_operator_id())
    )
  );

DROP POLICY IF EXISTS lot_status_history_bidder_read ON public.lot_status_history;
CREATE POLICY lot_status_history_bidder_read ON public.lot_status_history
  FOR SELECT TO authenticated
  USING (
    (SELECT is_bidder()) AND EXISTS (
      SELECT 1
      FROM invoice_lots il
      JOIN invoices i ON i.id = il.invoice_id
      WHERE il.lot_id = lot_status_history.lot_id
        AND i.bidder_id = (SELECT auth.uid())
    )
  );

-- ============================================================================
-- Table: public.auction_status_history — 2 policies
-- ============================================================================

DROP POLICY IF EXISTS auction_status_history_operator_read ON public.auction_status_history;
CREATE POLICY auction_status_history_operator_read ON public.auction_status_history
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM auctions a
      WHERE a.id = auction_status_history.auction_id
        AND a.operator_id = (SELECT current_operator_id())
    )
  );

DROP POLICY IF EXISTS auction_status_history_bidder_read ON public.auction_status_history;
CREATE POLICY auction_status_history_bidder_read ON public.auction_status_history
  FOR SELECT TO authenticated
  USING (
    (SELECT is_bidder()) AND EXISTS (
      SELECT 1 FROM auctions a
      WHERE a.id = auction_status_history.auction_id
        AND a.status IN ('scheduled', 'live', 'closed')
    )
  );

-- ============================================================================
-- Table: public.invoice_status_history — 2 policies
-- ============================================================================

DROP POLICY IF EXISTS invoice_status_history_operator_read ON public.invoice_status_history;
CREATE POLICY invoice_status_history_operator_read ON public.invoice_status_history
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_status_history.invoice_id
        AND i.operator_id = (SELECT current_operator_id())
    )
  );

DROP POLICY IF EXISTS invoice_status_history_bidder_read ON public.invoice_status_history;
CREATE POLICY invoice_status_history_bidder_read ON public.invoice_status_history
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_status_history.invoice_id
        AND i.bidder_id = (SELECT auth.uid())
    )
  );

-- ============================================================================
-- Table: public.operator_shipping_config — 1 policy
-- ============================================================================

DROP POLICY IF EXISTS operator_shipping_config_self_all ON public.operator_shipping_config;
CREATE POLICY operator_shipping_config_self_all
  ON public.operator_shipping_config FOR ALL
  USING (operator_id = (SELECT current_operator_id()))
  WITH CHECK (operator_id = (SELECT current_operator_id()));

-- ============================================================================
-- Table: public.warehouse_landmarks — 2 policies
-- ============================================================================

DROP POLICY IF EXISTS warehouse_landmarks_staff_all ON public.warehouse_landmarks;
CREATE POLICY warehouse_landmarks_staff_all
  ON public.warehouse_landmarks
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM warehouses w
      WHERE w.id = warehouse_landmarks.warehouse_id
        AND w.operator_id = (SELECT current_operator_id())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM warehouses w
      WHERE w.id = warehouse_landmarks.warehouse_id
        AND w.operator_id = (SELECT current_operator_id())
    )
  );

DROP POLICY IF EXISTS warehouse_landmarks_bidder_read ON public.warehouse_landmarks;
CREATE POLICY warehouse_landmarks_bidder_read
  ON public.warehouse_landmarks
  FOR SELECT TO authenticated
  USING (
    bidder_has_warehouse_access(warehouse_landmarks.warehouse_id)
  );

-- ============================================================================
-- Table: public.lot_import_batches — 3 policies
-- ============================================================================

DROP POLICY IF EXISTS lot_import_batches_own_select ON public.lot_import_batches;
CREATE POLICY lot_import_batches_own_select
  ON public.lot_import_batches FOR SELECT
  USING (operator_id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS lot_import_batches_own_insert ON public.lot_import_batches;
CREATE POLICY lot_import_batches_own_insert
  ON public.lot_import_batches FOR INSERT
  WITH CHECK (operator_id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS lot_import_batches_own_update ON public.lot_import_batches;
CREATE POLICY lot_import_batches_own_update
  ON public.lot_import_batches FOR UPDATE
  USING (operator_id = (SELECT current_operator_id()))
  WITH CHECK (operator_id = (SELECT current_operator_id()));

-- ============================================================================
-- Table: public.bidder_fee_ledger — 1 policy
-- ============================================================================

DROP POLICY IF EXISTS bidder_fee_ledger_own ON public.bidder_fee_ledger;
CREATE POLICY bidder_fee_ledger_own
  ON public.bidder_fee_ledger FOR SELECT
  USING (bidder_id = (SELECT auth.uid()));

-- ============================================================================
-- Table: public.operator_requests — 1 policy
-- (operator_requests_insert_anon uses WITH CHECK (true) — no helpers)
-- ============================================================================
-- operator_requests_insert_anon: WITH CHECK (true) — skip.

-- ============================================================================
-- Table: public.operator_invites — 1 policy
-- ============================================================================

DROP POLICY IF EXISTS operator_invites_admin_select ON public.operator_invites;
CREATE POLICY operator_invites_admin_select
  ON public.operator_invites FOR SELECT
  USING (created_by = (SELECT auth.uid()));

-- ============================================================================
-- Table: public.lot_sticker_pool — 1 policy
-- ============================================================================

DROP POLICY IF EXISTS lot_sticker_pool_operator_all ON public.lot_sticker_pool;
CREATE POLICY lot_sticker_pool_operator_all
  ON public.lot_sticker_pool FOR ALL
  USING (operator_id = (SELECT current_operator_id()))
  WITH CHECK (operator_id = (SELECT current_operator_id()));

-- ============================================================================
-- (mfa_trusted_devices policies omitted — that table comes from an
--  uncommitted local migration 0130 that hasn't merged yet. When 0130 lands,
--  add a follow-up migration that wraps its 2 policies the same way.)
-- ============================================================================

-- ============================================================================
-- storage.objects policies — only those that call our helpers
-- Note: policies that only reference bucket_id string comparisons or
--       completely public (USING (true) / no helpers) are skipped.
-- ============================================================================

-- Table: storage.objects — "lot-photos write — operator staff"
DROP POLICY IF EXISTS "lot-photos write — operator staff" ON storage.objects;
CREATE POLICY "lot-photos write — operator staff" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'lot-photos'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
  );

-- Table: storage.objects — "lot-photos delete — operator staff"
DROP POLICY IF EXISTS "lot-photos delete — operator staff" ON storage.objects;
CREATE POLICY "lot-photos delete — operator staff" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'lot-photos'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
  );

-- Table: storage.objects — "floor-plans staff write"
DROP POLICY IF EXISTS "floor-plans staff write" ON storage.objects;
CREATE POLICY "floor-plans staff write" ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'floor-plans'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
  )
  WITH CHECK (
    bucket_id = 'floor-plans'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
  );

-- Table: storage.objects — "floor-plans bidder read" (superseded by 0028 —
-- tightened to require paid invoice. The 0028 version uses auth.uid() not
-- is_bidder() so we wrap the auth.uid() call.)
DROP POLICY IF EXISTS "floor-plans bidder read" ON storage.objects;
CREATE POLICY "floor-plans bidder read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'floor-plans'
    AND (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.bidder_id = (SELECT auth.uid())
        AND i.status = 'paid'
        AND i.operator_id::text = (storage.foldername(name))[1]
    )
  );

-- Table: storage.objects — "staging-photos staff write"
DROP POLICY IF EXISTS "staging-photos staff write" ON storage.objects;
CREATE POLICY "staging-photos staff write" ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'staging-photos'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
  )
  WITH CHECK (
    bucket_id = 'staging-photos'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
  );

-- Table: storage.objects — "staging-photos bidder read own" (superseded by 0028)
DROP POLICY IF EXISTS "staging-photos bidder read own" ON storage.objects;
CREATE POLICY "staging-photos bidder read own" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'staging-photos'
    AND (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM bin_assignments ba
      JOIN invoice_lots il ON il.lot_id = ba.lot_id
      JOIN invoices i ON i.id = il.invoice_id
      WHERE ba.id::text = split_part(
              (storage.foldername(name))[2],
              '.',
              1
            )
        AND i.bidder_id = (SELECT auth.uid())
    )
  );

-- Table: storage.objects — "dispute-photos bidder write"
DROP POLICY IF EXISTS "dispute-photos bidder write" ON storage.objects;
CREATE POLICY "dispute-photos bidder write" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'dispute-photos'
    AND (SELECT is_bidder())
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

-- Table: storage.objects — "dispute-photos bidder read own"
DROP POLICY IF EXISTS "dispute-photos bidder read own" ON storage.objects;
CREATE POLICY "dispute-photos bidder read own" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'dispute-photos'
    AND (SELECT is_bidder())
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

-- Table: storage.objects — "dispute-photos operator read" (superseded by 0028)
DROP POLICY IF EXISTS "dispute-photos operator read" ON storage.objects;
CREATE POLICY "dispute-photos operator read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'dispute-photos'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM disputes d
      WHERE (storage.foldername(name))[2] = d.id::text
        AND d.operator_id = (SELECT current_operator_id())
    )
  );

-- Table: storage.objects — "bin-landmarks staff write"
DROP POLICY IF EXISTS "bin-landmarks staff write" ON storage.objects;
CREATE POLICY "bin-landmarks staff write" ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'bin-landmarks'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
  )
  WITH CHECK (
    bucket_id = 'bin-landmarks'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
  );

-- Table: storage.objects — "bin-landmarks bidder read" (superseded by 0028)
DROP POLICY IF EXISTS "bin-landmarks bidder read" ON storage.objects;
CREATE POLICY "bin-landmarks bidder read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'bin-landmarks'
    AND (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM bin_assignments ba
      JOIN invoice_lots il ON il.lot_id = ba.lot_id
      JOIN invoices i ON i.id = il.invoice_id
      WHERE ba.bin_id::text = split_part(
              (storage.foldername(name))[3],
              '.',
              1
            )
        AND ba.status IN ('staged', 'picked_up')
        AND i.bidder_id = (SELECT auth.uid())
    )
  );

-- Table: storage.objects — "operator-logos write — own operator"
DROP POLICY IF EXISTS "operator-logos write — own operator" ON storage.objects;
CREATE POLICY "operator-logos write — own operator" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'operator-logos'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
  );

-- Table: storage.objects — "operator-logos update — own operator"
DROP POLICY IF EXISTS "operator-logos update — own operator" ON storage.objects;
CREATE POLICY "operator-logos update — own operator" ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'operator-logos'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
  );

-- Table: storage.objects — "operator-logos delete — own operator"
DROP POLICY IF EXISTS "operator-logos delete — own operator" ON storage.objects;
CREATE POLICY "operator-logos delete — own operator" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'operator-logos'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
  );

-- Table: storage.objects — "dispute-evidence operator read"
DROP POLICY IF EXISTS "dispute-evidence operator read" ON storage.objects;
CREATE POLICY "dispute-evidence operator read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'dispute-evidence'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

-- Table: storage.objects — "dispute-evidence operator write"
DROP POLICY IF EXISTS "dispute-evidence operator write" ON storage.objects;
CREATE POLICY "dispute-evidence operator write" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'dispute-evidence'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

-- Table: storage.objects — "dispute-evidence operator delete"
DROP POLICY IF EXISTS "dispute-evidence operator delete" ON storage.objects;
CREATE POLICY "dispute-evidence operator delete" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'dispute-evidence'
    AND (SELECT current_operator_id()) IS NOT NULL
    AND (storage.foldername(name))[1] = (SELECT current_operator_id())::text
    AND (SELECT current_operator_role()) = 'admin'
  );

-- ============================================================================
-- Post-rewrite verification block
-- Counts policies per table and raises a NOTICE for review.
-- Non-fatal — verification is informational, not a gate.
-- ============================================================================

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='bidders';
  RAISE NOTICE 'public.bidders policies after rewrite: % (expected 3)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='operators';
  RAISE NOTICE 'public.operators policies after rewrite: % (expected 3)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='operator_users';
  RAISE NOTICE 'public.operator_users policies after rewrite: % (expected 2)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='warehouses';
  RAISE NOTICE 'public.warehouses policies after rewrite: % (expected 5)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='bins';
  RAISE NOTICE 'public.bins policies after rewrite: % (expected 2)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='auctions';
  RAISE NOTICE 'public.auctions policies after rewrite: % (expected 5)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='lots';
  RAISE NOTICE 'public.lots policies after rewrite: % (expected 5)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='bids';
  RAISE NOTICE 'public.bids policies after rewrite: % (expected 2)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='watchlist';
  RAISE NOTICE 'public.watchlist policies after rewrite: % (expected 1)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='invoices';
  RAISE NOTICE 'public.invoices policies after rewrite: % (expected 4)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='invoice_lots';
  RAISE NOTICE 'public.invoice_lots policies after rewrite: % (expected 2)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='bin_assignments';
  RAISE NOTICE 'public.bin_assignments policies after rewrite: % (expected 2)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='pickups';
  RAISE NOTICE 'public.pickups policies after rewrite: % (expected 2)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='disputes';
  RAISE NOTICE 'public.disputes policies after rewrite: % (expected 4)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='bidder_subscriptions';
  RAISE NOTICE 'public.bidder_subscriptions policies after rewrite: % (expected 2)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='operator_settlements';
  RAISE NOTICE 'public.operator_settlements policies after rewrite: % (expected 1)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='saved_searches';
  RAISE NOTICE 'public.saved_searches policies after rewrite: % (expected 1)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='imports';
  RAISE NOTICE 'public.imports policies after rewrite: % (expected 1)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='product_lookups';
  RAISE NOTICE 'public.product_lookups policies after rewrite: % (expected 1)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='import_rows';
  RAISE NOTICE 'public.import_rows policies after rewrite: % (expected 4)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='_schema_migrations';
  RAISE NOTICE 'public._schema_migrations policies after rewrite: % (expected 1)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='competitor_lots';
  RAISE NOTICE 'public.competitor_lots policies after rewrite: % (expected 1)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='ai_calls';
  RAISE NOTICE 'public.ai_calls policies after rewrite: % (expected 1)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='payment_followups';
  RAISE NOTICE 'public.payment_followups policies after rewrite: % (expected 1)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='operator_bidder_relations';
  RAISE NOTICE 'public.operator_bidder_relations policies after rewrite: % (expected 3)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='terms_acceptances';
  RAISE NOTICE 'public.terms_acceptances policies after rewrite: % (expected 1)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='operator_policies';
  RAISE NOTICE 'public.operator_policies policies after rewrite: % (expected 4)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='operator_policy_acceptances';
  RAISE NOTICE 'public.operator_policy_acceptances policies after rewrite: % (expected 2)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='lot_status_history';
  RAISE NOTICE 'public.lot_status_history policies after rewrite: % (expected 2)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='auction_status_history';
  RAISE NOTICE 'public.auction_status_history policies after rewrite: % (expected 2)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='invoice_status_history';
  RAISE NOTICE 'public.invoice_status_history policies after rewrite: % (expected 2)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='operator_shipping_config';
  RAISE NOTICE 'public.operator_shipping_config policies after rewrite: % (expected 1)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='warehouse_landmarks';
  RAISE NOTICE 'public.warehouse_landmarks policies after rewrite: % (expected 2)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='lot_import_batches';
  RAISE NOTICE 'public.lot_import_batches policies after rewrite: % (expected 3)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='bidder_fee_ledger';
  RAISE NOTICE 'public.bidder_fee_ledger policies after rewrite: % (expected 1)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='operator_invites';
  RAISE NOTICE 'public.operator_invites policies after rewrite: % (expected 1)', v_count;

  SELECT COUNT(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='lot_sticker_pool';
  RAISE NOTICE 'public.lot_sticker_pool policies after rewrite: % (expected 1)', v_count;

  -- Check no unwrapped helper calls remain in public schema policies.
  -- This query should return 0 rows if all helpers are properly wrapped.
  SELECT COUNT(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (
      (qual LIKE '%current_operator_id()%' AND qual NOT LIKE '%(SELECT current_operator_id())%')
      OR (qual LIKE '%current_operator_role()%' AND qual NOT LIKE '%(SELECT current_operator_role())%')
      OR (qual LIKE '%is_bidder()%' AND qual NOT LIKE '%(SELECT is_bidder())%')
      OR (with_check LIKE '%current_operator_id()%' AND with_check NOT LIKE '%(SELECT current_operator_id())%')
      OR (with_check LIKE '%current_operator_role()%' AND with_check NOT LIKE '%(SELECT current_operator_role())%')
      OR (with_check LIKE '%is_bidder()%' AND with_check NOT LIKE '%(SELECT is_bidder())%')
    );
  RAISE NOTICE 'Policies with unwrapped helper calls in public schema (MUST BE 0): %', v_count;

END;
$$;

-- ============================================================================
-- TODO: unit test file
-- Create packages/db/migrations/tests/0133_rls_subquery_wrap_test.sql
-- with pgTAP-style assertions on pg_policies.qual containing
-- '(SELECT current_operator_id())', '(SELECT auth.uid())', etc.
-- Skipped here because the test infra is not yet wired into CI; tracked
-- as a follow-up in the audit doc DB-4 item.
-- ============================================================================

COMMIT;
