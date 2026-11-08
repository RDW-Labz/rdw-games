-- app_read_paths_smoke.sql
-- ----------------------------------------------------------------------------
-- RUNTIME DRIFT GUARD for the app read paths.
--
-- WHY: the bugs fixed on 2026-06-03 (operator-settings audit, PRs #203/#204)
-- were "write->read drift" — the UI/cron read a column or PostgREST embed that
-- a later migration renamed/removed/relocated. These passed `tsc` because the
-- Supabase clients are untyped (they cast results), and passed schema-migrations
-- because the migrations themselves applied cleanly. The bug only showed up at
-- RUNTIME. This file closes that gap.
--
-- WHAT: against the freshly-migrated schema (the schema-check job's Postgres),
-- it asserts that every COLUMN, FOREIGN-KEY relationship, RLS POLICY, and RPC
-- the operator-web + bidder-app + field-mobile runtime read paths depend on
-- still exists. Inventory source: docs/audits/operator-settings-audit + a
-- repo-wide read-path sweep (2026-06-04).
--
-- HOW: mirrors cron_functions_smoke.sql — runs as the migration applier
-- (superuser; RLS bypassed) so we validate SCHEMA SHAPE, not data or RLS
-- enforcement. Every `SELECT ... WHERE false` plans the exact query shape an
-- app issues (embeds expressed as JOINs); a missing column/relation aborts at
-- parse/plan time. Catalog DO-blocks assert FKs / policies / functions exist.
-- Touches no rows. Run with `psql -v ON_ERROR_STOP=1 -f`.
--
-- MAINTENANCE: when you add a runtime read of a new column/embed/RPC on a
-- critical path (money, auth, bidder-facing, operator settings), add its shape
-- below. This is a SMOKE layer (drift detection), not full E2E.
-- ----------------------------------------------------------------------------

\set ON_ERROR_STOP on

-- ============================================================================
-- 1. QUERY SHAPES — column + embed (FK-JOIN) drift
--    Each block is the SQL equivalent of a real app .select() with its
--    PostgREST embeds as LEFT JOINs. WHERE false => validate-only, no rows.
-- ============================================================================

-- bidder lot detail — apps/bidder-app/app/lot/[id].tsx (#1 shipping flag lives here)
SELECT l.id, l.lot_code, l.title, l.description, l.current_bid_cents,
       l.starting_bid_cents, l.close_at, l.status, l.msrp_cents, l.condition,
       l.bid_count, l.winner_bidder_id, l.flat_price_cents, l.dutch_start_cents,
       l.dutch_floor_cents, l.dutch_decline_per_minute_cents, l.photo_urls,
       l.operator_id, l.auction_id, l.category, l.early_access_until,
       a.format, a.starts_at, a.pickup_ends_at,
       o.business_name, o.logo_url, o.brand_color, o.offers_shipping
FROM lots l
LEFT JOIN auctions a ON a.id = l.auction_id
LEFT JOIN operators o ON o.id = l.operator_id
WHERE false;

-- bidder memberships list — apps/bidder-app/app/subscription/index.tsx (#204)
SELECT p.id, p.operator_id, p.name, p.price_cents, p.active,
       o.business_name, o.logo_url, o.brand_color, o.status
FROM operator_pro_plans p
JOIN operators o ON o.id = p.operator_id
WHERE false;

-- membership checkout + perk reads — api/subscriptions/checkout + auto-charge-drain
SELECT p.id, p.operator_id, p.name, p.price_cents, p.stripe_price_id,
       p.stripe_product_id, p.active, p.extended_pickup_days,
       p.extra_grace_hours, p.staging_prep
FROM operator_pro_plans p WHERE false;
SELECT s.bidder_id, s.operator_id, s.plan_id, s.status, s.current_period_end,
       pp.extra_grace_hours, pp.staging_prep, pp.name
FROM bidder_subscriptions s
LEFT JOIN operator_pro_plans pp ON pp.id = s.plan_id
WHERE false;

-- invoice payment-intent + auto-charge money path (#3 tax cols, Connect cols)
SELECT i.id, i.status, i.bidder_id, i.total_cents, i.tax_cents,
       i.application_fee_cents, i.stripe_payment_intent_id,
       i.authentication_required_at, i.fulfillment_method, i.operator_id, i.auction_id,
       o.stripe_account_id, o.stripe_charges_enabled, o.collect_sales_tax,
       o.auto_charge_grace_hours
FROM invoices i LEFT JOIN operators o ON o.id = i.operator_id WHERE false;

-- warehouse-origin tax shipping — lib/stripe-tax.ts (auctions -> warehouses)
SELECT a.id, w.address_line1, w.address_line2, w.city, w.state,
       w.postal_code, w.country
FROM auctions a LEFT JOIN warehouses w ON w.id = a.warehouse_id WHERE false;

-- settlements ledger — app/(operator)/settlements (#8)
SELECT st.id, st.operator_id, st.invoice_id, st.amount_cents,
       st.application_fee_cents, st.refund_cents, st.status, st.release_at,
       st.transferred_at,
       inv.total_cents, inv.paid_at
FROM operator_settlements st
LEFT JOIN invoices inv ON inv.id = st.invoice_id
WHERE false;

-- operator settings reads — settings/* + account/policies (#1,#3,#6,#7,#8)
SELECT id, slug, business_name, legal_name, contact_email, contact_phone,
       logo_url, brand_color, default_buyer_premium_bps, default_soft_close_minutes,
       auto_relist_enabled, auto_relist_max_attempts, auto_relist_mode,
       offers_pickup, offers_shipping, collect_sales_tax, settlement_hold_days,
       membership_fee_bps, application_fee_bps, auto_charge_grace_hours, is_demo,
       dispute_window_days, no_show_forfeit_threshold, forfeit_cooldown_days
FROM operators WHERE false;

-- operator_policies — money + disputes + bidder visibility (#4 demote area)
SELECT operator_id, version, published, terms_md, refund_md, shipping_md,
       payment_window_hours, pickup_window_days, refund_window_post_pickup_hours,
       no_show_policy, restock_fee_cents, relist_fee_cents,
       admin_can_refund_outside_window, dispute_response_hours, effective_at,
       content_hash, created_at
FROM operator_policies WHERE false;

-- bidder invoice receipt — apps/bidder-app/app/invoice/[id].tsx (deep embed chain)
SELECT i.id, i.status, i.total_cents, i.fulfillment_method, i.shipping_address,
       o.business_name, o.offers_pickup, o.offers_shipping,
       a.pickup_starts_at, a.pickup_ends_at,
       w.name, w.timezone,
       il.lot_id, il.winning_bid_cents, l.title, l.lot_code
FROM invoices i
LEFT JOIN operators o ON o.id = i.operator_id
LEFT JOIN auctions a ON a.id = i.auction_id
LEFT JOIN warehouses w ON w.id = a.warehouse_id
LEFT JOIN invoice_lots il ON il.invoice_id = i.id
LEFT JOIN lots l ON l.id = il.lot_id
WHERE false;

-- my-bids — apps/bidder-app/app/(tabs)/my-bids.tsx (bids -> lots disambiguated FK)
SELECT bd.lot_id, bd.amount_cents, bd.max_amount_cents, bd.placed_at,
       l.lot_code, l.title, l.status, l.current_bid_cents, l.close_at,
       l.winner_bidder_id, l.auction_id, l.photo_urls
FROM bids bd LEFT JOIN lots l ON l.id = bd.lot_id WHERE false;

-- field-mobile forfeited-lots chain: lots -> invoice_lots -> invoices -> pickups
SELECT l.id, l.lot_code, l.flagged_for_disposal, l.sticker_code, l.source,
       l.intake_bin_id, l.warehouse_id
FROM lots l WHERE false;
SELECT il.lot_id, inv.id, pk.status
FROM invoice_lots il
LEFT JOIN invoices inv ON inv.id = il.invoice_id
LEFT JOIN pickups pk ON pk.invoice_id = inv.id
WHERE false;

-- pickup verify (field-mobile) + bidder pickup — intake_bin named FK + bins embed
SELECT l.id, l.title, l.intake_bin_id, b.code AS intake_bin_code
FROM lots l LEFT JOIN bins b ON b.id = l.intake_bin_id WHERE false;
SELECT ba.lot_id, ba.bin_id, ba.status, ba.assigned_at, bn.code
FROM bin_assignments ba LEFT JOIN bins bn ON bn.id = ba.bin_id WHERE false;

-- RLS-qual gating columns (must exist or the bidder/auction policies break)
SELECT is_demo FROM operators WHERE false;
SELECT is_reviewer, unpaid_fees_cents, stripe_customer_id, default_payment_method_id
FROM bidders WHERE false;

-- ============================================================================
-- 2. FOREIGN KEYS the PostgREST embeds resolve through
-- ============================================================================
DO $$
DECLARE
  fks text[][] := ARRAY[
    ARRAY['lots','operator_id','operators'],
    ARRAY['lots','auction_id','auctions'],
    ARRAY['lots','warehouse_id','warehouses'],
    ARRAY['lots','intake_bin_id','bins'],
    ARRAY['operator_pro_plans','operator_id','operators'],
    ARRAY['bidder_subscriptions','plan_id','operator_pro_plans'],
    ARRAY['invoice_lots','invoice_id','invoices'],
    ARRAY['invoice_lots','lot_id','lots'],
    ARRAY['invoices','auction_id','auctions'],
    ARRAY['invoices','operator_id','operators'],
    ARRAY['auctions','warehouse_id','warehouses'],
    ARRAY['bids','lot_id','lots'],
    ARRAY['bin_assignments','lot_id','lots'],
    ARRAY['bin_assignments','bin_id','bins'],
    ARRAY['pickups','invoice_id','invoices'],
    ARRAY['operator_settlements','invoice_id','invoices']
  ];
  fk text[];
  missing text := '';
BEGIN
  FOREACH fk SLICE 1 IN ARRAY fks LOOP
    PERFORM 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = fk[1]
      AND kcu.column_name = fk[2]
      AND ccu.table_name = fk[3];
    IF NOT FOUND THEN
      missing := missing || format(E'  %s.%s -> %s\n', fk[1], fk[2], fk[3]);
    END IF;
  END LOOP;
  IF missing <> '' THEN
    RAISE EXCEPTION E'app_read_paths_smoke: missing FK relationship(s) PostgREST embeds depend on:\n%', missing;
  END IF;
END $$;

-- ============================================================================
-- 3. RLS — enabled + at least one SELECT-capable policy on each client-read
--    table. Name-agnostic on purpose (a rename is fine; a DROP that strips
--    public/bidder read is the real failure — that would empty the storefront).
-- ============================================================================
DO $$
DECLARE
  tbls text[] := ARRAY[
    'lots','auctions','operators','operator_pro_plans','operator_policies',
    'bidder_subscriptions','bids','invoices','invoice_lots','pickups',
    'bin_assignments','bins','warehouses','watchlist','bidders'
  ];
  t text;
  missing_rls text := '';
  missing_pol text := '';
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    PERFORM 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity;
    IF NOT FOUND THEN
      missing_rls := missing_rls || '  ' || t || E'\n';
    END IF;
    PERFORM 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
        AND cmd IN ('SELECT','ALL') AND permissive = 'PERMISSIVE';
    IF NOT FOUND THEN
      missing_pol := missing_pol || '  ' || t || E'\n';
    END IF;
  END LOOP;
  IF missing_rls <> '' THEN
    RAISE EXCEPTION E'app_read_paths_smoke: RLS not enabled on client-read table(s):\n%', missing_rls;
  END IF;
  IF missing_pol <> '' THEN
    RAISE EXCEPTION E'app_read_paths_smoke: no SELECT/ALL policy on client-read table(s):\n%', missing_pol;
  END IF;
END $$;

-- ============================================================================
-- 4. RPC functions the apps call by name (the name IS the contract — a rename
--    or drop breaks supabase.rpc('...')). Verified present in migrations.
-- ============================================================================
DO $$
DECLARE
  fns text[] := ARRAY[
    'place_bid','set_invoice_fulfillment','intake_lot_to_bin',
    'batch_intake_lot_to_bin','assign_lot_to_bin','staff_confirm_pickup',
    'bidder_confirm_customer_pickup','delete_my_account','cancel_auction',
    'redistribute_close_times','resolve_category_ids_batch',
    'staff_scan_bidder_token'
  ];
  fn text;
  missing text := '';
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    PERFORM 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = fn AND n.nspname = 'public';
    IF NOT FOUND THEN
      missing := missing || '  ' || fn || E'\n';
    END IF;
  END LOOP;
  IF missing <> '' THEN
    RAISE EXCEPTION E'app_read_paths_smoke: missing RPC function(s) the apps call:\n%', missing;
  END IF;
END $$;

-- ============================================================================
-- 5. RPC BEHAVIOR — staff_scan_bidder_token no-auth guard (mig 0206).
--    auth.uid() is NULL in the schema-check job (stubbed), so
--    current_operator_id() returns NULL and the function MUST return the
--    documented { ok:false, reason:'not_operator_staff' } shape. Proves the
--    function applies AND returns the contracted JSON on the only path
--    reachable without a GoTrue session. (Happy-path coverage lives in
--    test/staff_scan_bidder_token.regression.test.ts, behind a Supabase stack.)
-- ============================================================================
DO $$
DECLARE
  v jsonb;
BEGIN
  v := staff_scan_bidder_token('00000000-0000-0000-0000-000000000000'::uuid);
  IF v IS NULL OR (v->>'ok') <> 'false' OR (v->>'reason') <> 'not_operator_staff' THEN
    RAISE EXCEPTION 'app_read_paths_smoke: staff_scan_bidder_token no-auth guard returned unexpected shape: %', v;
  END IF;
END $$;

-- All assertions passed.
SELECT 'app_read_paths_smoke: OK' AS result;
