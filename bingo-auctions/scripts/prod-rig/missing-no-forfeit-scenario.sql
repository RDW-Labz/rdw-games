-- 0393 proof: an item reported missing at the counter is not forfeited when
-- the pickup goes no-show. Run on a fresh copy of rigbase (prod's function
-- bodies over a full migration replay), before and after 0393, and diff.
-- Everything runs in one transaction and rolls back, so it can be rerun.
--
-- One paid invoice, three lines:
--   RIG-PICKED   picked up at the counter
--   RIG-MISSING  reported missing at the counter, refund not yet issued
--   RIG-PLAIN    never collected (the ordinary forfeit)
-- The pickup window closed three days ago; the real sweep
-- (auto_mark_pickup_no_show) flips the pickup to no_show.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on

BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('00000000-0000-0000-0000-00000000039a', 'rig-0393', 'Rig 0393', 'rig0393@example.test', 'R93');
INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('00000000-0000-0000-0000-0000000039a1', '00000000-0000-0000-0000-00000000039a', 'WH', '1 Main', 'Harrison', 'AR', '72601');
INSERT INTO auctions (id, operator_id, warehouse_id, title, starts_at, ends_at, pickup_starts_at, pickup_ends_at, status, soft_close_minutes, unlisted)
VALUES ('00000000-0000-0000-0000-0000000039c1', '00000000-0000-0000-0000-00000000039a', '00000000-0000-0000-0000-0000000039a1',
        'Rig 0393 auction', now() - interval '6 days', now() - interval '5 days', now() - interval '5 days', now() - interval '3 days', 'closed', 2, false);
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000039b1', 'b0393@example.test');
INSERT INTO bidders (id, email, default_payment_method_id, birth_date)
VALUES ('00000000-0000-0000-0000-0000000039b1', 'b0393@example.test', 'ccof:b0393', '1980-01-01');
INSERT INTO lots (id, operator_id, auction_id, warehouse_id, title, lot_code, status, starting_bid_cents, msrp_cents, winner_bidder_id, current_bid_cents)
SELECT v.id::uuid, '00000000-0000-0000-0000-00000000039a', '00000000-0000-0000-0000-0000000039c1', '00000000-0000-0000-0000-0000000039a1',
       v.title, v.code, 'won', 100, 5000, '00000000-0000-0000-0000-0000000039b1', 1000
  FROM (VALUES ('00000000-0000-0000-0000-0000000039d1', 'Picked up', 'RIG-PICKED'),
               ('00000000-0000-0000-0000-0000000039d2', 'Missing',   'RIG-MISSING'),
               ('00000000-0000-0000-0000-0000000039d3', 'Plain',     'RIG-PLAIN')) v(id, title, code);
INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, subtotal_cents, total_cents, paid_at)
VALUES ('00000000-0000-0000-0000-0000000039e1', '00000000-0000-0000-0000-00000000039a', '00000000-0000-0000-0000-0000000039c1',
        '00000000-0000-0000-0000-0000000039b1', 'paid', 3000, 3000, now() - interval '5 days');
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at)
VALUES ('00000000-0000-0000-0000-0000000039e1', '00000000-0000-0000-0000-0000000039d1', 1000, now() - interval '4 days'),
       ('00000000-0000-0000-0000-0000000039e1', '00000000-0000-0000-0000-0000000039d2', 1000, NULL),
       ('00000000-0000-0000-0000-0000000039e1', '00000000-0000-0000-0000-0000000039d3', 1000, NULL);
-- The counter's visit: one item handed over, one not on the shelf. The pickup
-- row stays open (partial hand-off), so the sweep will catch it.
INSERT INTO pickups (id, invoice_id, warehouse_id, status, checked_in_at)
VALUES ('00000000-0000-0000-0000-0000000039f1', '00000000-0000-0000-0000-0000000039e1', '00000000-0000-0000-0000-0000000039a1',
        'checked_in', now() - interval '4 days');
INSERT INTO pickup_lot_outcomes (pickup_id, lot_id, outcome)
VALUES ('00000000-0000-0000-0000-0000000039f1', '00000000-0000-0000-0000-0000000039d1', 'collected'),
       ('00000000-0000-0000-0000-0000000039f1', '00000000-0000-0000-0000-0000000039d2', 'missing');

SELECT 'SWEEP pickups_flipped=' || (r ->> 'pickups_flipped') || ' lots_routed_to_unsold=' || (r ->> 'lots_routed_to_unsold')
  FROM (SELECT auto_mark_pickup_no_show() AS r) s;
SELECT 'PICKUP status=' || status FROM pickups WHERE id = '00000000-0000-0000-0000-0000000039f1';
SELECT 'LINE ' || l.lot_code || ' forfeited=' || (il.forfeited_at IS NOT NULL) || ' picked_up=' || (il.picked_up_at IS NOT NULL)
       || ' lot_status=' || l.status
  FROM invoice_lots il JOIN lots l ON l.id = il.lot_id
 WHERE il.invoice_id = '00000000-0000-0000-0000-0000000039e1'
 ORDER BY l.lot_code;

ROLLBACK;
