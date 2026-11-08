-- finalize_lot proof scenario. Run on a fresh copy of rigbase (prod's exact
-- engine functions over a full migration replay). Same script for OLD and NEW.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on

-- ── seed ────────────────────────────────────────────────────────────────────
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('00000000-0000-0000-0000-00000000000a', 'bingo-rig', 'BinGo Rig', 'rig@example.test', 'RIG');
INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'WH', '1 Main', 'Harrison', 'AR', '72601');
INSERT INTO auctions (id, operator_id, warehouse_id, title, starts_at, ends_at, pickup_starts_at, pickup_ends_at, status, soft_close_minutes, unlisted)
VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
        'Rig auction', now() - interval '1 hour', now() + interval '2 hours', now() + interval '3 hours', now() + interval '3 days', 'live', 2, false);
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000b1', 'b1@example.test'), ('00000000-0000-0000-0000-0000000000b2', 'b2@example.test'), ('00000000-0000-0000-0000-0000000000b3', 'b3@example.test');
INSERT INTO bidders (id, email, default_payment_method_id, birth_date)
VALUES ('00000000-0000-0000-0000-0000000000b1', 'b1@example.test', 'ccof:b1', '1980-01-01'),
       ('00000000-0000-0000-0000-0000000000b2', 'b2@example.test', 'ccof:b2', '1980-01-01'),
       ('00000000-0000-0000-0000-0000000000b3', 'b3@example.test', 'ccof:b3', '1980-01-01');
INSERT INTO lots (id, operator_id, auction_id, warehouse_id, title, lot_code, status, starting_bid_cents, msrp_cents, close_at)
VALUES ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Lot A (bids)',       'RIG-A', 'live', 100, 5000, now() + interval '1 hour'),
       ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Lot B (no bids)',    'RIG-B', 'live', 100, 5000, now() + interval '1 hour'),
       ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Lot C (soft close)', 'RIG-C', 'live', 100, 5000, now() + interval '1 hour');

CREATE TEMP TABLE trace (step int, what text);
CREATE TEMP TABLE t0 AS SELECT now() AS at;

-- ── 1. two real bids on A, an hour from close: no extension ────────────────
SET request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
INSERT INTO trace SELECT 1, 'b1 bids A 500: ' || (place_bid('00000000-0000-0000-0000-0000000000d1', 500)).reason;
SET request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
INSERT INTO trace SELECT 1, 'b2 bids A 800: ' || (place_bid('00000000-0000-0000-0000-0000000000d1', 800)).reason;
RESET request.jwt.claim.sub;
INSERT INTO trace SELECT 1, 'A after bids: leader=' || right(winner_bidder_id::text, 2) || ' current=' || current_bid_cents
  || ' close_at moved=' || (close_at > (SELECT at FROM t0) + interval '61 minutes') FROM lots WHERE lot_code = 'RIG-A';

-- ── 2. C 30 s from close, then a bid: the soft-close extension ─────────────
UPDATE lots SET close_at = now() + interval '30 seconds' WHERE lot_code = 'RIG-C';
CREATE TEMP TABLE c_before AS SELECT close_at FROM lots WHERE lot_code = 'RIG-C';
SET request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b3';
INSERT INTO trace SELECT 2, 'b3 bids C 300: ' || (place_bid('00000000-0000-0000-0000-0000000000d3', 300)).reason;
RESET request.jwt.claim.sub;
INSERT INTO trace SELECT 2, 'C extended by soft close: ' || (l.close_at > c.close_at)
  || ', to ~' || round(extract(epoch FROM l.close_at - now()) / 60.0)::int || ' min from now'
  FROM lots l, c_before c WHERE l.lot_code = 'RIG-C';

-- ── 3. A and B come due (time passing = close_at moved into the past) ──────
UPDATE lots SET close_at = now() - interval '1 second' WHERE lot_code IN ('RIG-A', 'RIG-B');
INSERT INTO trace SELECT 3, 'finalize_due_lots #1: won=' || (finalize_due_lots() ->> 'won');
INSERT INTO trace SELECT 3, 'C direct finalize while extended: ' || (finalize_lot('00000000-0000-0000-0000-0000000000d3')).reason;

-- ── 4. C's extended close passes ────────────────────────────────────────────
UPDATE lots SET close_at = now() - interval '1 second' WHERE lot_code = 'RIG-C';
INSERT INTO trace SELECT 4, 'finalize_due_lots #2: won=' || (finalize_due_lots() ->> 'won');
INSERT INTO trace SELECT 4, 'finalize_due_lots #3 (nothing due): ' || coalesce(finalize_due_lots() ->> 'won', 'null');

-- ── 5. invoice build (the charge queue) ─────────────────────────────────────
UPDATE build_invoice_jobs SET run_at = now() - interval '1 second';
INSERT INTO trace SELECT 5, 'build jobs queued: ' || (SELECT count(*) FROM build_invoice_jobs);
SELECT drain_build_invoice_jobs() \g /dev/null

-- ── snapshot (ids → labels, no timestamps) ──────────────────────────────────
CREATE TEMP TABLE lab AS
  SELECT '00000000-0000-0000-0000-0000000000b1'::uuid AS id, 'b1' AS l UNION ALL
  SELECT '00000000-0000-0000-0000-0000000000b2', 'b2' UNION ALL
  SELECT '00000000-0000-0000-0000-0000000000b3', 'b3';
SELECT 'TRACE ' || step || ' ' || what FROM trace ORDER BY step, what;
SELECT 'LOT ' || lot_code || ' status=' || status || ' winner=' || coalesce((SELECT l FROM lab WHERE id = winner_bidder_id), '-')
  || ' price=' || coalesce(current_bid_cents::text, '-') || ' bids=' || bid_count || ' closed=' || (closed_at IS NOT NULL)
  FROM lots WHERE lot_code LIKE 'RIG-%' ORDER BY lot_code;
SELECT 'NOTE ' || kind || ' -> ' || coalesce((SELECT l FROM lab WHERE id = target_user_id), '?') || ' lot=' || coalesce((SELECT lot_code FROM lots WHERE id::text = payload ->> 'lot_id'), '-')
  FROM notifications_outbox ORDER BY kind, target_user_id, payload ->> 'lot_id';
SELECT 'INVOICE ' || (SELECT l FROM lab WHERE id = i.bidder_id) || ' status=' || i.status || ' subtotal=' || i.subtotal_cents
  || ' premium=' || i.buyer_premium_cents || ' tax=' || i.tax_cents || ' total=' || i.total_cents
  || ' lots=' || (SELECT string_agg(l.lot_code || ':' || il.winning_bid_cents, ',' ORDER BY l.lot_code) FROM invoice_lots il JOIN lots l ON l.id = il.lot_id WHERE il.invoice_id = i.id)
  FROM invoices i ORDER BY 1;
SELECT 'CHARGE_JOB ' || (SELECT l FROM lab WHERE id = i.bidder_id) || ' total=' || i.total_cents
  FROM auto_charge_jobs j JOIN invoices i ON i.id = j.invoice_id ORDER BY 1;
SELECT 'COUNT build_jobs_left=' || (SELECT count(*) FROM build_invoice_jobs) || ' invoices=' || (SELECT count(*) FROM invoices) || ' charge_jobs=' || (SELECT count(*) FROM auto_charge_jobs);
