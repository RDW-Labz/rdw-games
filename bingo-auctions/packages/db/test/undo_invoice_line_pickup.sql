-- Behavioural test for mig 0487's undo_invoice_line_pickup().
-- Plain-psql assertions, no pgTAP (matches invoice_lots_forfeited_at.sql).
--
-- The console could only ever STAMP a pickup (#702: TEA3828564 marked picked
-- up by mistake with the box still on the shelf). This pins the reversal:
--
--   • admin only — a manager and a picker are both refused 'forbidden'
--   • a reason of at least 5 characters is required
--   • a refunded line is refused, an unpaid invoice is refused, a line from
--     another invoice is 'not_found'
--   • a successful undo clears picked_up_at, flips the lot's latest pickup
--     bin_assignment back to 'staged', removes the line's 'collected' outcome
--     and pickup-pass tick (leaving sibling B's tick/outcome alone), reopens a
--     completed pickup as 'checked_in', and writes ONE audit row
--   • a second call is a no-op (already_undone) and writes no second audit row
--   • a lot relisted with a live child is refused 'relist_child_live'
--   • a forfeited line (0256 forfeited-not-resold) IS allowed, and reports
--     forfeit_remains so 0444's undo forfeit can run next
--   • an EXPIRED visit is refused 'pickup_expired' and nothing moves: the
--     line is not handed to the 0337/0183 sweep to forfeit and relist
--   • a closed (no_show/forfeited) visit is refused 'pickup_closed'
--   • a stale concurrent completion cannot re-stamp an undone line: the
--     BEFORE trigger keeps the pickup 'checked_in' while it is owed, while an
--     ordinary legacy completion with no undone line still completes
--   • a LATER explicit 'collected' handover on the same visit is not stale:
--     it completes, stamps the line, and the sweep cannot reclaim it
--   • the documented rollback restores one undone line, its exact bin row and
--     timestamp, its collected outcome and session tick, keeps the pickup
--     checked_in while a sibling is owed, and restores 'completed' only when
--     nothing else is owed (also exercising two independent undos)
--   • a refused restore (refunded line, moved/re-staged bin, repeated audit
--     id) is a complete no-op for line, bin, outcomes, ticks and pickup
--   • other lines on the invoice are untouched
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched. Run from the REPO ROOT: the
-- rollback section includes scripts/prod-rig/0487_ROLLBACK_*.

\set ON_ERROR_STOP on

BEGIN;

-- Who is calling: a session setting the stub auth.uid() reads.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('a7000000-0000-0000-0000-0000000000b1', 'uptest', 'UP Co', 'up@example.com', 'UPT');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('a7000000-0000-0000-0000-0000000000b2', 'a7000000-0000-0000-0000-0000000000b1',
        'UP WH', '1 U St', 'Harrison', 'AR', '72601');

INSERT INTO bins (id, warehouse_id, code, aisle, x_px, y_px)
VALUES ('a7000000-0000-0000-0000-0000000000b9', 'a7000000-0000-0000-0000-0000000000b2',
        'U-01-1-01', 'U', 0, 0);

INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at) VALUES
  ('a7000000-0000-0000-0000-0000000000b3', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'UP A', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
  -- invoices are UNIQUE (auction_id, bidder_id), so each fixture invoice needs
  -- its own auction
  ('a7000000-0000-0000-0000-0000000000b4', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'UP B', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
  -- expired window: pickup ended 2 days ago (grace default 0 on this operator)
  ('a7000000-0000-0000-0000-0000000000b5', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'UP Expired', 'draft',
   now() - interval '5 days', now() - interval '4 days',
   now() - interval '4 days', now() - interval '3 days'),
  -- future windows for the concurrency / legacy / restore fixtures
  ('a7000000-0000-0000-0000-0000000000b6', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'UP Concurrency', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
  ('a7000000-0000-0000-0000-0000000000b7', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'UP Legacy', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
  ('a7000000-0000-0000-0000-0000000000b8', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'UP Restore', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
  -- refused-restore fixtures: undo then refund / undo then move
  ('a7000000-0000-0000-0000-0000000000b9', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'UP Refund Restore', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
  ('a7000000-0000-0000-0000-0000000000ba', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'UP Moved Restore', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days');

INSERT INTO auth.users (id, email) VALUES
  ('a7000000-0000-0000-0000-0000000000c1', 'up-admin@example.com'),
  ('a7000000-0000-0000-0000-0000000000c2', 'up-manager@example.com'),
  ('a7000000-0000-0000-0000-0000000000c3', 'up-picker@example.com'),
  ('a7000000-0000-0000-0000-0000000000c4', 'up-buyer@example.com');

INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
  ('a7000000-0000-0000-0000-0000000000b1', 'a7000000-0000-0000-0000-0000000000c1', 'admin', 'up-admin@example.com'),
  ('a7000000-0000-0000-0000-0000000000b1', 'a7000000-0000-0000-0000-0000000000c2', 'manager', 'up-manager@example.com'),
  ('a7000000-0000-0000-0000-0000000000b1', 'a7000000-0000-0000-0000-0000000000c3', 'picker', 'up-picker@example.com');

INSERT INTO bidders (id, email, birth_date)
VALUES ('a7000000-0000-0000-0000-0000000000c4', 'up-buyer@example.com', DATE '1990-01-01');

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, paid_at, total_cents) VALUES
  ('a7000000-0000-0000-0000-0000000000d1', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b3', 'a7000000-0000-0000-0000-0000000000c4', 'paid', now(), 1000),
  ('a7000000-0000-0000-0000-0000000000d2', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b4', 'a7000000-0000-0000-0000-0000000000c4', 'pending', NULL, 1000),
  ('a7000000-0000-0000-0000-0000000000d3', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b5', 'a7000000-0000-0000-0000-0000000000c4', 'paid', now(), 1000),
  ('a7000000-0000-0000-0000-0000000000d4', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b6', 'a7000000-0000-0000-0000-0000000000c4', 'paid', now(), 1000),
  ('a7000000-0000-0000-0000-0000000000d5', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b7', 'a7000000-0000-0000-0000-0000000000c4', 'paid', now(), 1000),
  ('a7000000-0000-0000-0000-0000000000d6', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b8', 'a7000000-0000-0000-0000-0000000000c4', 'paid', now(), 1000),
  ('a7000000-0000-0000-0000-0000000000d7', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b9', 'a7000000-0000-0000-0000-0000000000c4', 'paid', now(), 1000),
  ('a7000000-0000-0000-0000-0000000000d8', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000ba', 'a7000000-0000-0000-0000-0000000000c4', 'paid', now(), 1000);

INSERT INTO lots (id, operator_id, warehouse_id, lot_code, title, status) VALUES
  -- line 1: the wrong pickup — the case this migration exists for
  ('a7000000-0000-0000-0000-0000000000e1', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-1', 'wrongly picked up', 'won'),
  -- line 2: still owed, must not be touched
  ('a7000000-0000-0000-0000-0000000000e2', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-2', 'still owed', 'won'),
  -- line 3: refunded, refused
  ('a7000000-0000-0000-0000-0000000000e3', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-3', 'refunded', 'won'),
  -- line 4: forfeited-not-resold, allowed but the forfeit remains
  ('a7000000-0000-0000-0000-0000000000e4', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-4', 'forfeited then stamped', 'won'),
  -- line 5: relisted since the pickup, refused
  ('a7000000-0000-0000-0000-0000000000e5', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-5', 'relisted after pickup', 'won'),
  -- the live relist child of line 5
  ('a7000000-0000-0000-0000-0000000000e6', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-6', 'the relist', 'scheduled'),
  -- line 6: picked up on the UNPAID invoice, refused
  ('a7000000-0000-0000-0000-0000000000e7', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-7', 'picked up on unpaid', 'won'),
  -- expired visit
  ('a7000000-0000-0000-0000-0000000000e8', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-8', 'expired window', 'won'),
  -- concurrency: A stamped, B owed
  ('a7000000-0000-0000-0000-0000000000e9', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-9', 'undone while B owed', 'won'),
  ('a7000000-0000-0000-0000-0000000000ea', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-10', 'sibling owed', 'won'),
  -- legacy completion: open line, no undo audit
  ('a7000000-0000-0000-0000-0000000000eb', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-11', 'legacy completion', 'won'),
  -- single-line restore: the only line, completed visit
  ('a7000000-0000-0000-0000-0000000000ec', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-12', 'single-line restore', 'won'),
  -- refused restore after a refund
  ('a7000000-0000-0000-0000-0000000000ed', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-13', 'undone then refunded', 'won'),
  -- refused restore after the item moved / was re-staged
  ('a7000000-0000-0000-0000-0000000000ee', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-14', 'undone then moved', 'won');

UPDATE lots SET relisted_from_lot_id = 'a7000000-0000-0000-0000-0000000000e5'
 WHERE id = 'a7000000-0000-0000-0000-0000000000e6';

INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at, refunded_at, forfeited_at) VALUES
  ('a7000000-0000-0000-0000-0000000000d1','a7000000-0000-0000-0000-0000000000e1', 1000, now(), NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000d1','a7000000-0000-0000-0000-0000000000e2', 1000, NULL,  NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000d1','a7000000-0000-0000-0000-0000000000e3', 1000, now(), now(), NULL),
  ('a7000000-0000-0000-0000-0000000000d1','a7000000-0000-0000-0000-0000000000e4', 1000, now(), NULL, now()),
  ('a7000000-0000-0000-0000-0000000000d1','a7000000-0000-0000-0000-0000000000e5', 1000, now(), NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000d2','a7000000-0000-0000-0000-0000000000e7', 1000, now(), NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000d3','a7000000-0000-0000-0000-0000000000e8', 1000, now(), NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000d4','a7000000-0000-0000-0000-0000000000e9', 1000, now(), NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000d4','a7000000-0000-0000-0000-0000000000ea', 1000, NULL, NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000d5','a7000000-0000-0000-0000-0000000000eb', 1000, NULL, NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000d6','a7000000-0000-0000-0000-0000000000ec', 1000, now(), NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000d7','a7000000-0000-0000-0000-0000000000ed', 1000, now(), NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000d8','a7000000-0000-0000-0000-0000000000ee', 1000, now(), NULL, NULL);

INSERT INTO pickups (id, invoice_id, warehouse_id, status, checked_in_at, completed_at) VALUES
  ('a7000000-0000-0000-0000-0000000000d9', 'a7000000-0000-0000-0000-0000000000d1',
   'a7000000-0000-0000-0000-0000000000b2', 'completed', now(), now()),
  ('a7000000-0000-0000-0000-0000000000d8', 'a7000000-0000-0000-0000-0000000000d3',
   'a7000000-0000-0000-0000-0000000000b2', 'completed', now(), now()),
  ('a7000000-0000-0000-0000-0000000000da', 'a7000000-0000-0000-0000-0000000000d4',
   'a7000000-0000-0000-0000-0000000000b2', 'checked_in', now(), NULL),
  ('a7000000-0000-0000-0000-0000000000db', 'a7000000-0000-0000-0000-0000000000d5',
   'a7000000-0000-0000-0000-0000000000b2', 'checked_in', now(), NULL),
  ('a7000000-0000-0000-0000-0000000000dc', 'a7000000-0000-0000-0000-0000000000d6',
   'a7000000-0000-0000-0000-0000000000b2', 'completed', now(), now()),
  ('a7000000-0000-0000-0000-0000000000dd', 'a7000000-0000-0000-0000-0000000000d7',
   'a7000000-0000-0000-0000-0000000000b2', 'completed', now(), now()),
  ('a7000000-0000-0000-0000-0000000000de', 'a7000000-0000-0000-0000-0000000000d8',
   'a7000000-0000-0000-0000-0000000000b2', 'completed', now(), now());

-- A second bin so the moved / re-staged fixture can point somewhere else.
INSERT INTO bins (id, warehouse_id, code, aisle, x_px, y_px)
VALUES ('a7000000-0000-0000-0000-0000000000ba', 'a7000000-0000-0000-0000-0000000000b2',
        'U-02-2-02', 'U', 0, 0);

-- The stamp's bin flip (0256/0217 set the latest assignment to picked_up).
INSERT INTO bin_assignments (lot_id, bin_id, status, assigned_at, picked_up_at) VALUES
  ('a7000000-0000-0000-0000-0000000000e1', 'a7000000-0000-0000-0000-0000000000b9', 'picked_up', now(), now()),
  ('a7000000-0000-0000-0000-0000000000ed', 'a7000000-0000-0000-0000-0000000000b9', 'picked_up', now(), now()),
  ('a7000000-0000-0000-0000-0000000000ee', 'a7000000-0000-0000-0000-0000000000b9', 'picked_up', now(), now());

-- Wrong hand-over records that must move with the stamp (MEDIUM: a surviving
-- 'collected' outcome hides the item and a session tick blocks a relist).
INSERT INTO pickup_sessions (id, bidder_id, status, collected_lot_ids)
VALUES ('a7000000-0000-0000-0000-0000000000f1', 'a7000000-0000-0000-0000-0000000000c4',
        'open', ARRAY['a7000000-0000-0000-0000-0000000000e1',
                      'a7000000-0000-0000-0000-0000000000e2',
                      'a7000000-0000-0000-0000-0000000000e9',
                      'a7000000-0000-0000-0000-0000000000ea',
                      'a7000000-0000-0000-0000-0000000000ed',
                      'a7000000-0000-0000-0000-0000000000ee',
                      'a7000000-0000-0000-0000-0000000000f5',
                      'a7000000-0000-0000-0000-0000000000f6',
                      'a7000000-0000-0000-0000-0000000000f7',
                      'a7000000-0000-0000-0000-0000000000f8',
                      'a7000000-0000-0000-0000-0000000000f9']::uuid[]);

INSERT INTO pickup_lot_outcomes (pickup_id, lot_id, outcome) VALUES
  ('a7000000-0000-0000-0000-0000000000d9', 'a7000000-0000-0000-0000-0000000000e1', 'collected'),
  ('a7000000-0000-0000-0000-0000000000d9', 'a7000000-0000-0000-0000-0000000000e2', 'collected'),
  ('a7000000-0000-0000-0000-0000000000da', 'a7000000-0000-0000-0000-0000000000e9', 'collected'),
  ('a7000000-0000-0000-0000-0000000000dd', 'a7000000-0000-0000-0000-0000000000ed', 'collected'),
  ('a7000000-0000-0000-0000-0000000000de', 'a7000000-0000-0000-0000-0000000000ee', 'collected');

-- ---------------------------------------------------------------------------
-- #796 fixtures: decision timestamps, stale-preflight restores, RPC races
-- ---------------------------------------------------------------------------
INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at) VALUES
  ('a7000000-0000-0000-0000-0000000000bb', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'UP Later Handover', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
  ('a7000000-0000-0000-0000-0000000000bc', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'UP Race Refund', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
  ('a7000000-0000-0000-0000-0000000000bd', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'UP Race Move', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
  ('a7000000-0000-0000-0000-0000000000be', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'UP Staff RPC Race', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
  ('a7000000-0000-0000-0000-0000000000bf', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'UP Manager RPC Race', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days');

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, paid_at, total_cents) VALUES
  ('a7000000-0000-0000-0000-0000000000f0', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000bb', 'a7000000-0000-0000-0000-0000000000c4', 'paid', now(), 1000),
  ('a7000000-0000-0000-0000-0000000000f1', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000bc', 'a7000000-0000-0000-0000-0000000000c4', 'paid', now(), 1000),
  ('a7000000-0000-0000-0000-0000000000f2', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000bd', 'a7000000-0000-0000-0000-0000000000c4', 'paid', now(), 1000),
  ('a7000000-0000-0000-0000-0000000000f3', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000be', 'a7000000-0000-0000-0000-0000000000c4', 'paid', now(), 1000),
  ('a7000000-0000-0000-0000-0000000000f4', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000bf', 'a7000000-0000-0000-0000-0000000000c4', 'paid', now(), 1000);

INSERT INTO lots (id, operator_id, warehouse_id, lot_code, title, status) VALUES
  ('a7000000-0000-0000-0000-0000000000f5', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-15', 'later handover', 'won'),
  ('a7000000-0000-0000-0000-0000000000f6', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-16', 'stale preflight refund', 'won'),
  ('a7000000-0000-0000-0000-0000000000f7', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-17', 'stale preflight move', 'won'),
  ('a7000000-0000-0000-0000-0000000000f8', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-18', 'staff RPC race', 'won'),
  ('a7000000-0000-0000-0000-0000000000f9', 'a7000000-0000-0000-0000-0000000000b1',
   'a7000000-0000-0000-0000-0000000000b2', 'TE-19', 'manager RPC race', 'won');

INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at, picked_up_by, refunded_at, forfeited_at) VALUES
  ('a7000000-0000-0000-0000-0000000000f0','a7000000-0000-0000-0000-0000000000f5', 1000, now(), NULL, NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000f1','a7000000-0000-0000-0000-0000000000f6', 1000, now(), NULL, NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000f2','a7000000-0000-0000-0000-0000000000f7', 1000, now(), NULL, NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000f3','a7000000-0000-0000-0000-0000000000f8', 1000, now(), NULL, NULL, NULL),
  ('a7000000-0000-0000-0000-0000000000f4','a7000000-0000-0000-0000-0000000000f9', 1000, now(), NULL, NULL, NULL);

INSERT INTO pickups (id, invoice_id, warehouse_id, status, checked_in_at, completed_at) VALUES
  ('a7000000-0000-0000-0000-0000000000fa', 'a7000000-0000-0000-0000-0000000000f0',
   'a7000000-0000-0000-0000-0000000000b2', 'completed', now(), now()),
  ('a7000000-0000-0000-0000-0000000000fb', 'a7000000-0000-0000-0000-0000000000f1',
   'a7000000-0000-0000-0000-0000000000b2', 'completed', now(), now()),
  ('a7000000-0000-0000-0000-0000000000fc', 'a7000000-0000-0000-0000-0000000000f2',
   'a7000000-0000-0000-0000-0000000000b2', 'completed', now(), now()),
  ('a7000000-0000-0000-0000-0000000000fd', 'a7000000-0000-0000-0000-0000000000f3',
   'a7000000-0000-0000-0000-0000000000b2', 'checked_in', now(), NULL),
  ('a7000000-0000-0000-0000-0000000000fe', 'a7000000-0000-0000-0000-0000000000f4',
   'a7000000-0000-0000-0000-0000000000b2', 'checked_in', now(), NULL);

INSERT INTO bin_assignments (lot_id, bin_id, status, assigned_at, picked_up_at) VALUES
  ('a7000000-0000-0000-0000-0000000000f5', 'a7000000-0000-0000-0000-0000000000b9', 'picked_up', now(), now()),
  ('a7000000-0000-0000-0000-0000000000f6', 'a7000000-0000-0000-0000-0000000000b9', 'picked_up', now(), now()),
  ('a7000000-0000-0000-0000-0000000000f7', 'a7000000-0000-0000-0000-0000000000b9', 'picked_up', now(), now()),
  ('a7000000-0000-0000-0000-0000000000f8', 'a7000000-0000-0000-0000-0000000000b9', 'picked_up', now(), now()),
  ('a7000000-0000-0000-0000-0000000000f9', 'a7000000-0000-0000-0000-0000000000b9', 'picked_up', now(), now());

-- #796 finding 1: an OLD 'missing' row, later changed to Collected through the
-- console (UPSERT updates the outcome, not created_at).
INSERT INTO pickup_lot_outcomes
  (pickup_id, lot_id, outcome, created_at, decided_at)
VALUES ('a7000000-0000-0000-0000-0000000000fa',
        'a7000000-0000-0000-0000-0000000000f5', 'missing',
        now() - interval '2 hours', now() - interval '2 hours');

-- Wrong hand-over records for the two stale-preflight rollback fixtures.
INSERT INTO pickup_lot_outcomes (pickup_id, lot_id, outcome) VALUES
  ('a7000000-0000-0000-0000-0000000000fb', 'a7000000-0000-0000-0000-0000000000f6', 'collected'),
  ('a7000000-0000-0000-0000-0000000000fc', 'a7000000-0000-0000-0000-0000000000f7', 'collected');

-- Old-audit replay fixture: two undos of the same line, replay the older one.
INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('a7000000-0000-0000-0000-0000000000c0', 'a7000000-0000-0000-0000-0000000000b1',
        'a7000000-0000-0000-0000-0000000000b2', 'UP Old Audit', 'draft',
        now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days');

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, paid_at, total_cents)
VALUES ('a7000000-0000-0000-0000-0000000000c5', 'a7000000-0000-0000-0000-0000000000b1',
        'a7000000-0000-0000-0000-0000000000c0', 'a7000000-0000-0000-0000-0000000000c4',
        'paid', now(), 1000);

INSERT INTO lots (id, operator_id, warehouse_id, lot_code, title, status)
VALUES ('a7000000-0000-0000-0000-0000000000c6', 'a7000000-0000-0000-0000-0000000000b1',
        'a7000000-0000-0000-0000-0000000000b2', 'TE-20', 'old audit replay', 'won');

INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at) VALUES
  ('a7000000-0000-0000-0000-0000000000c5','a7000000-0000-0000-0000-0000000000c6', 1000, now());

INSERT INTO pickups (id, invoice_id, warehouse_id, status, checked_in_at, completed_at)
VALUES ('a7000000-0000-0000-0000-0000000000c7', 'a7000000-0000-0000-0000-0000000000c5',
        'a7000000-0000-0000-0000-0000000000b2', 'completed', now(), now());

INSERT INTO bin_assignments (lot_id, bin_id, status, assigned_at, picked_up_at)
VALUES ('a7000000-0000-0000-0000-0000000000c6', 'a7000000-0000-0000-0000-0000000000b9',
        'picked_up', now(), now());

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_res         jsonb;
  v_audit_count int;
  v_old_stamp   timestamptz;
BEGIN
  SELECT picked_up_at INTO v_old_stamp FROM invoice_lots
   WHERE lot_id = 'a7000000-0000-0000-0000-0000000000e1';

  -- 1. Manager and picker are refused: #706 says admin only.
  PERFORM set_config('test.uid', 'a7000000-0000-0000-0000-0000000000c2', true);
  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d1',
                                    'a7000000-0000-0000-0000-0000000000e1',
                                    'wrong lot scanned at the counter');
  IF v_res->>'code' <> 'forbidden' THEN
    RAISE EXCEPTION 'a MANAGER was not refused (got %)', v_res;
  END IF;

  PERFORM set_config('test.uid', 'a7000000-0000-0000-0000-0000000000c3', true);
  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d1',
                                    'a7000000-0000-0000-0000-0000000000e1',
                                    'wrong lot scanned at the counter');
  IF v_res->>'code' <> 'forbidden' THEN
    RAISE EXCEPTION 'a PICKER was not refused (got %)', v_res;
  END IF;

  PERFORM set_config('test.uid', 'a7000000-0000-0000-0000-0000000000c1', true);

  -- 2. The reason is required.
  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d1',
                                    'a7000000-0000-0000-0000-0000000000e1', '  oops  ');
  IF v_res->>'code' <> 'reason_required' THEN
    RAISE EXCEPTION 'a short reason was not refused (got %)', v_res;
  END IF;

  -- 3. A refunded line, an unpaid invoice and a foreign line are refused.
  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d1',
                                    'a7000000-0000-0000-0000-0000000000e3',
                                    'wrong lot scanned at the counter');
  IF v_res->>'code' <> 'refunded' THEN
    RAISE EXCEPTION 'a REFUNDED line was not refused (got %)', v_res;
  END IF;
  -- The #702 shape: a refunded line's history is not corrected by this tool
  -- until a separate workflow is approved. Refusal must move no money and
  -- write no audit row.
  IF (SELECT status::text || ':' || total_cents::text || ':' ||
             coalesce(refunded_cash_cents, 0)::text || ':' ||
             coalesce(refunded_credit_cents, 0)::text
        FROM invoices WHERE id = 'a7000000-0000-0000-0000-0000000000d1')
     <> 'paid:1000:0:0' THEN
    RAISE EXCEPTION 'the refunded refusal changed the invoice money state';
  END IF;
  IF EXISTS (SELECT 1 FROM operator_audit_log
              WHERE action_type = 'invoice_line.pickup_undone'
                AND target_id = 'a7000000-0000-0000-0000-0000000000d1'
                AND before_state->>'lot_id' = 'a7000000-0000-0000-0000-0000000000e3') THEN
    RAISE EXCEPTION 'the refunded refusal wrote an audit row';
  END IF;

  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d2',
                                    'a7000000-0000-0000-0000-0000000000e7',
                                    'wrong lot scanned at the counter');
  IF v_res->>'code' <> 'invoice_not_paid' THEN
    RAISE EXCEPTION 'an UNPAID invoice was not refused (got %)', v_res;
  END IF;

  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d2',
                                    'a7000000-0000-0000-0000-0000000000e1',
                                    'wrong lot scanned at the counter');
  IF v_res->>'code' <> 'not_found' THEN
    RAISE EXCEPTION 'a line off the invoice was not refused (got %)', v_res;
  END IF;

  -- 4. A lot that has since been relisted is refused.
  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d1',
                                    'a7000000-0000-0000-0000-0000000000e5',
                                    'wrong lot scanned at the counter');
  IF v_res->>'code' <> 'relist_child_live' THEN
    RAISE EXCEPTION 'a RELISTED lot was not refused (got %)', v_res;
  END IF;

  -- 5. Nothing above changed anything.
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000e1') IS DISTINCT FROM v_old_stamp THEN
    RAISE EXCEPTION 'a refused call cleared the stamp';
  END IF;

  -- 6. The success path.
  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d1',
                                    'a7000000-0000-0000-0000-0000000000e1',
                                    'wrong lot scanned at the counter');
  IF v_res->>'ok' <> 'true' OR v_res->>'reverted' <> 'true' THEN
    RAISE EXCEPTION 'the undo did not report success (got %)', v_res;
  END IF;
  IF v_res->>'lot_code' <> 'TE-1' THEN
    RAISE EXCEPTION 'the undo reported the wrong lot code (got %)', v_res;
  END IF;
  IF COALESCE(v_res->>'forfeit_remains', 'null') <> 'false' THEN
    RAISE EXCEPTION 'a non-forfeited line reported forfeit_remains (got %)', v_res;
  END IF;
  IF v_res->>'collected_outcomes_removed' <> '1' THEN
    RAISE EXCEPTION 'the collected outcome was not removed (got %)', v_res;
  END IF;
  IF v_res->>'session_ticks_removed' <> '1' THEN
    RAISE EXCEPTION 'the pickup-pass tick was not removed (got %)', v_res;
  END IF;

  IF (SELECT picked_up_at FROM invoice_lots
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000e1') IS NOT NULL THEN
    RAISE EXCEPTION 'picked_up_at was not cleared';
  END IF;

  IF (SELECT status FROM bin_assignments
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000e1') <> 'staged' THEN
    RAISE EXCEPTION 'the bin assignment was not put back to staged';
  END IF;
  IF (SELECT picked_up_at FROM bin_assignments
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000e1') IS NOT NULL THEN
    RAISE EXCEPTION 'the bin assignment kept its picked_up_at';
  END IF;

  -- The wrong hand-over records are gone; a sibling's stay.
  IF EXISTS (SELECT 1 FROM pickup_lot_outcomes
              WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000d9'
                AND lot_id = 'a7000000-0000-0000-0000-0000000000e1') THEN
    RAISE EXCEPTION 'the collected outcome survived the undo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pickup_lot_outcomes
                  WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000d9'
                    AND lot_id = 'a7000000-0000-0000-0000-0000000000e2') THEN
    RAISE EXCEPTION 'a sibling collected outcome was removed';
  END IF;
  IF (SELECT collected_lot_ids @> ARRAY['a7000000-0000-0000-0000-0000000000e1']::uuid[]
        FROM pickup_sessions WHERE id = 'a7000000-0000-0000-0000-0000000000f1') THEN
    RAISE EXCEPTION 'the undone lot is still ticked on the pickup pass';
  END IF;
  IF NOT (SELECT collected_lot_ids @> ARRAY['a7000000-0000-0000-0000-0000000000e2']::uuid[]
            FROM pickup_sessions WHERE id = 'a7000000-0000-0000-0000-0000000000f1') THEN
    RAISE EXCEPTION 'a sibling pickup-pass tick was removed';
  END IF;

  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000d9') <> 'checked_in' THEN
    RAISE EXCEPTION 'the completed pickup was not reopened';
  END IF;
  IF (SELECT completed_at FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000d9') IS NOT NULL THEN
    RAISE EXCEPTION 'the reopened pickup kept completed_at';
  END IF;

  SELECT count(*) INTO v_audit_count FROM operator_audit_log
   WHERE action_type = 'invoice_line.pickup_undone'
     AND target_id = 'a7000000-0000-0000-0000-0000000000d1';
  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'expected 1 audit row, found %', v_audit_count;
  END IF;

  -- The audit carries the exact prior bin row so the rollback can restore it.
  IF (SELECT before_state->'bin_assignment'->>'status' FROM operator_audit_log
       WHERE action_type = 'invoice_line.pickup_undone'
         AND target_id = 'a7000000-0000-0000-0000-0000000000d1') <> 'picked_up' THEN
    RAISE EXCEPTION 'the audit did not record the prior bin assignment';
  END IF;

  -- Other lines on the invoice are untouched.
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000e3') IS NULL THEN
    RAISE EXCEPTION 'the refunded line lost its stamp';
  END IF;
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000e5') IS NULL THEN
    RAISE EXCEPTION 'the relisted line lost its stamp';
  END IF;

  -- 7. Idempotent: a second call is a no-op and writes no second audit row.
  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d1',
                                    'a7000000-0000-0000-0000-0000000000e1',
                                    'wrong lot scanned at the counter');
  IF v_res->>'ok' <> 'true' OR v_res->>'already_undone' <> 'true' THEN
    RAISE EXCEPTION 'a second call was not a no-op (got %)', v_res;
  END IF;
  SELECT count(*) INTO v_audit_count FROM operator_audit_log
   WHERE action_type = 'invoice_line.pickup_undone'
     AND target_id = 'a7000000-0000-0000-0000-0000000000d1';
  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'the no-op wrote an audit row (now %)', v_audit_count;
  END IF;

  -- 8. A forfeited line is allowed, and says the forfeit remains so 0444's
  --    undo forfeit can run next (it refuses a line that is still picked up).
  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d1',
                                    'a7000000-0000-0000-0000-0000000000e4',
                                    'customer was at the counter mid-handover');
  IF v_res->>'ok' <> 'true' THEN
    RAISE EXCEPTION 'a forfeited + picked-up line was refused (got %)', v_res;
  END IF;
  IF v_res->>'forfeit_remains' <> 'true' THEN
    RAISE EXCEPTION 'a forfeited line did not report forfeit_remains (got %)', v_res;
  END IF;
  IF (SELECT forfeited_at FROM invoice_lots
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000e4') IS NULL THEN
    RAISE EXCEPTION 'the undo cleared the forfeit as well';
  END IF;

  -- 9. HIGH: an expired visit is refused, so the 0337/0183 sweep cannot
  --    silently forfeit / re-list the line we just put back.
  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d3',
                                    'a7000000-0000-0000-0000-0000000000e8',
                                    'wrong lot scanned at the counter');
  IF v_res->>'code' <> 'pickup_expired' THEN
    RAISE EXCEPTION 'an EXPIRED visit was not refused (got %)', v_res;
  END IF;
  IF v_res->>'pickup_deadline' IS NULL THEN
    RAISE EXCEPTION 'the expired refusal did not report the deadline (got %)', v_res;
  END IF;
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000e8') IS NULL THEN
    RAISE EXCEPTION 'the expired refusal cleared the stamp';
  END IF;
  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000d8') <> 'completed' THEN
    RAISE EXCEPTION 'the expired refusal reopened the pickup';
  END IF;
  SELECT count(*) INTO v_audit_count FROM operator_audit_log
   WHERE action_type = 'invoice_line.pickup_undone'
     AND target_id = 'a7000000-0000-0000-0000-0000000000d3';
  IF v_audit_count <> 0 THEN
    RAISE EXCEPTION 'the expired refusal wrote an audit row';
  END IF;

  -- A closed visit is refused too: putting the line back on a no_show /
  -- forfeited pickup would not return it to the pickup pass.
  UPDATE pickups SET status = 'forfeited' WHERE id = 'a7000000-0000-0000-0000-0000000000d8';
  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d3',
                                    'a7000000-0000-0000-0000-0000000000e8',
                                    'wrong lot scanned at the counter');
  IF v_res->>'code' <> 'pickup_closed' THEN
    RAISE EXCEPTION 'a CLOSED visit was not refused (got %)', v_res;
  END IF;

  -- 10. MEDIUM: undo on a partly-collected visit, then a stale concurrent
  --     completion must not re-stamp the line we put back.
  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d4',
                                    'a7000000-0000-0000-0000-0000000000e9',
                                    'wrong lot scanned at the counter');
  IF v_res->>'ok' <> 'true' THEN
    RAISE EXCEPTION 'the concurrency fixture undo failed (got %)', v_res;
  END IF;
  UPDATE pickups SET status = 'completed', completed_at = now()
   WHERE id = 'a7000000-0000-0000-0000-0000000000da';
  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000da') <> 'checked_in' THEN
    RAISE EXCEPTION 'a completed pickup kept an undone line owed';
  END IF;
  IF (SELECT completed_at FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000da') IS NOT NULL THEN
    RAISE EXCEPTION 'the blocked completion kept completed_at';
  END IF;
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000e9') IS NOT NULL THEN
    RAISE EXCEPTION 'the concurrent completion re-stamped the undone line';
  END IF;
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000ea') IS NOT NULL THEN
    RAISE EXCEPTION 'the concurrent completion stamped an unrelated owed line';
  END IF;

  -- Ordinary legacy completion (open line, no undo audit) still completes and
  -- stamps through 0356; the guard is scoped to undone lines.
  UPDATE pickups SET status = 'completed', completed_at = now()
   WHERE id = 'a7000000-0000-0000-0000-0000000000db';
  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000db') <> 'completed' THEN
    RAISE EXCEPTION 'an ordinary completion was blocked';
  END IF;
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000eb') IS NULL THEN
    RAISE EXCEPTION 'an ordinary completion did not stamp its open line';
  END IF;

  -- 11. HIGH: a LATER genuine Collected handover after the undo must complete
  --     and stamp. The fresh outcome is a person saying the box left on a
  --     later visit, so it is not the stale completion the guard exists for.
  INSERT INTO pickup_lot_outcomes (pickup_id, lot_id, outcome, decided_by)
  VALUES ('a7000000-0000-0000-0000-0000000000da',
          'a7000000-0000-0000-0000-0000000000e9', 'collected',
          'a7000000-0000-0000-0000-0000000000c1');
  UPDATE pickups SET status = 'completed', completed_at = now()
   WHERE id = 'a7000000-0000-0000-0000-0000000000da';
  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000da') <> 'completed' THEN
    RAISE EXCEPTION 'a later explicit collected handover was blocked';
  END IF;
  IF (SELECT completed_at FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000da') IS NULL THEN
    RAISE EXCEPTION 'a later explicit collected handover kept completed_at NULL';
  END IF;
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000e9') IS NULL THEN
    RAISE EXCEPTION 'a later explicit collected handover was not stamped';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pickup_lot_outcomes
                  WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000da'
                    AND lot_id = 'a7000000-0000-0000-0000-0000000000e9'
                    AND outcome = 'collected') THEN
    RAISE EXCEPTION 'the later collected outcome was removed';
  END IF;

  RAISE NOTICE 'undo_invoice_line_pickup: all assertions OK';
END $$;

-- ---------------------------------------------------------------------------
-- #796 finding 1: a row DECIDED again after the undo is a later handover.
--
-- An existing 'missing' row changed to Collected through the console UPSERT
-- keeps its old created_at, so the old guard saw a stale decision and kept the
-- pickup checked_in even though a person had just said the box left. The
-- stamping trigger moves decided_at on the real change; completion must then
-- persist AND stamp the line. A stale collected decision (decided before the
-- undo) must still block.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_res     jsonb;
  v_before  timestamptz;
  v_after   timestamptz;
  v_after2  timestamptz;
BEGIN
  PERFORM set_config('test.uid', 'a7000000-0000-0000-0000-0000000000c1', true);

  v_res := undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000f0',
                                    'a7000000-0000-0000-0000-0000000000f5',
                                    'wrong lot scanned at the counter');
  IF v_res->>'ok' <> 'true' THEN
    RAISE EXCEPTION 'the later-handover undo failed (got %)', v_res;
  END IF;
  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000fa') <> 'checked_in' THEN
    RAISE EXCEPTION 'the later-handover pickup was not reopened';
  END IF;

  SELECT decided_at INTO v_before FROM pickup_lot_outcomes
   WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000fa'
     AND lot_id = 'a7000000-0000-0000-0000-0000000000f5';
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'the seeded outcome has no decided_at';
  END IF;

  -- The real console path: UPSERT changes outcome on the existing row. The
  -- database trigger must move decided_at even though created_at stays put.
  INSERT INTO pickup_lot_outcomes (pickup_id, lot_id, outcome, decided_by)
  VALUES ('a7000000-0000-0000-0000-0000000000fa',
          'a7000000-0000-0000-0000-0000000000f5', 'collected',
          'a7000000-0000-0000-0000-0000000000c1')
  ON CONFLICT (pickup_id, lot_id) DO UPDATE
     SET outcome = EXCLUDED.outcome,
         decided_by = EXCLUDED.decided_by;

  SELECT decided_at INTO v_after FROM pickup_lot_outcomes
   WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000fa'
     AND lot_id = 'a7000000-0000-0000-0000-0000000000f5';
  IF v_after <= v_before THEN
    RAISE EXCEPTION 'decided_at did not move on a real outcome change (% -> %)',
      v_before, v_after;
  END IF;
  IF (SELECT created_at FROM pickup_lot_outcomes
       WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000fa'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000f5')
     >= v_after THEN
    RAISE EXCEPTION 'the upsert moved created_at instead of decided_at';
  END IF;

  UPDATE pickups SET status = 'completed', completed_at = now()
   WHERE id = 'a7000000-0000-0000-0000-0000000000fa';
  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000fa') <> 'completed' THEN
    RAISE EXCEPTION 'a later decided handover was still blocked';
  END IF;
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000f0'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000f5') IS NULL THEN
    RAISE EXCEPTION 'a later decided handover was not stamped';
  END IF;

  -- Stale control: a collected decision older than the undo still blocks, and
  -- leaves the visit checked_in with no completion stamp. Seeded with a fresh
  -- INSERT (an INSERT may carry an explicit event time; a re-UPSERT may not,
  -- see the identical-UPSERT regression below).
  UPDATE pickups
     SET status = 'checked_in', completed_at = NULL
   WHERE id = 'a7000000-0000-0000-0000-0000000000fa';
  UPDATE invoice_lots SET picked_up_at = NULL
   WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000f0'
     AND lot_id = 'a7000000-0000-0000-0000-0000000000f5';
  DELETE FROM pickup_lot_outcomes
   WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000fa'
     AND lot_id = 'a7000000-0000-0000-0000-0000000000f5';
  INSERT INTO pickup_lot_outcomes
    (pickup_id, lot_id, outcome, decided_by, created_at, decided_at)
  VALUES ('a7000000-0000-0000-0000-0000000000fa',
          'a7000000-0000-0000-0000-0000000000f5', 'collected',
          'a7000000-0000-0000-0000-0000000000c1',
          now() - interval '1 hour', now() - interval '1 hour');

  -- #798 finding 1: replay the EXACT app UPSERT payload (same
  -- outcome/decider/note) with a NEW caller timestamp. The database is the
  -- authority, so decided_at must not move and the stale decision must keep
  -- blocking completion.
  INSERT INTO pickup_lot_outcomes
    (pickup_id, lot_id, outcome, decided_by, decided_at)
  VALUES ('a7000000-0000-0000-0000-0000000000fa',
          'a7000000-0000-0000-0000-0000000000f5', 'collected',
          'a7000000-0000-0000-0000-0000000000c1', clock_timestamp())
  ON CONFLICT (pickup_id, lot_id) DO UPDATE
     SET outcome    = EXCLUDED.outcome,
         decided_by = EXCLUDED.decided_by,
         decided_at = EXCLUDED.decided_at;

  SELECT decided_at INTO v_after2 FROM pickup_lot_outcomes
   WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000fa'
     AND lot_id = 'a7000000-0000-0000-0000-0000000000f5';
  IF v_after2 >= now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'an identical UPSERT refreshed the stale decided_at (% -> %)',
      v_after2, clock_timestamp();
  END IF;

  UPDATE pickups SET status = 'completed', completed_at = now()
   WHERE id = 'a7000000-0000-0000-0000-0000000000fa';
  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000fa') <> 'checked_in' THEN
    RAISE EXCEPTION 'a STALE collected decision completed the visit';
  END IF;
  IF (SELECT completed_at FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000fa') IS NOT NULL THEN
    RAISE EXCEPTION 'a stale collected decision kept completed_at';
  END IF;
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000f0'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000f5') IS NOT NULL THEN
    RAISE EXCEPTION 'a stale collected decision stamped the line';
  END IF;

  RAISE NOTICE '0487 #796: decided_at handover OK';
  RAISE NOTICE '0487 #798: identical UPSERT cannot refresh a stale decision';
END $$;

-- ---------------------------------------------------------------------------
-- Rollback: restore ONE undone line from its audit row, guarded.
-- ---------------------------------------------------------------------------

-- Partial visit: A (TE-1) undone, sibling TE-2 still owed. Restoring A must
-- put its exact bin row/timestamp, outcome and session tick back, and must NOT
-- mark the pickup completed (TE-2 is still owed).
SELECT a.id AS restore_audit_id
  FROM operator_audit_log a
 WHERE a.action_type = 'invoice_line.pickup_undone'
   AND a.target_id = 'a7000000-0000-0000-0000-0000000000d1'
   AND a.before_state->>'lot_id' = 'a7000000-0000-0000-0000-0000000000e1'
 ORDER BY a.created_at DESC
 LIMIT 1
\gset
\set keep_function 1
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql

SELECT set_config('test.restore_audit_id', :'restore_audit_id', true);

DO $$
DECLARE
  v_before jsonb;
BEGIN
  SELECT before_state INTO v_before FROM operator_audit_log
   WHERE id = current_setting('test.restore_audit_id')::bigint;

  IF (SELECT picked_up_at FROM invoice_lots
       WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000d1'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000e1')
     IS DISTINCT FROM (v_before->>'picked_up_at')::timestamptz THEN
    RAISE EXCEPTION 'the rollback did not restore the line stamp';
  END IF;

  IF (SELECT status::text FROM bin_assignments
       WHERE id = (v_before->'bin_assignment'->>'id')::uuid) <> 'picked_up' THEN
    RAISE EXCEPTION 'the rollback did not restore the bin status';
  END IF;
  IF (SELECT picked_up_at FROM bin_assignments
       WHERE id = (v_before->'bin_assignment'->>'id')::uuid)
     IS DISTINCT FROM (v_before->'bin_assignment'->>'picked_up_at')::timestamptz THEN
    RAISE EXCEPTION 'the rollback did not restore the exact bin timestamp';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pickup_lot_outcomes
                  WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000d9'
                    AND lot_id = 'a7000000-0000-0000-0000-0000000000e1'
                    AND outcome = 'collected') THEN
    RAISE EXCEPTION 'the rollback did not restore the collected outcome';
  END IF;

  -- #798 finding 4: the undo's DELETE ... RETURNING must carry decided_at and
  -- the restore must put the exact decision time back (not fall back to
  -- created_at for a modern audit row).
  IF (v_before->'removed_collected_outcomes'->0->>'decided_at') IS NULL THEN
    RAISE EXCEPTION 'the undo audit lost the removed outcome decided_at';
  END IF;
  IF (SELECT decided_at FROM pickup_lot_outcomes
       WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000d9'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000e1')
     IS DISTINCT FROM
     (v_before->'removed_collected_outcomes'->0->>'decided_at')::timestamptz THEN
    RAISE EXCEPTION 'the rollback did not preserve the exact decided_at';
  END IF;
  IF (SELECT created_at FROM pickup_lot_outcomes
       WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000d9'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000e1')
     IS DISTINCT FROM
     (v_before->'removed_collected_outcomes'->0->>'created_at')::timestamptz THEN
    RAISE EXCEPTION 'the rollback did not preserve the exact created_at';
  END IF;
  IF NOT (SELECT collected_lot_ids @> ARRAY['a7000000-0000-0000-0000-0000000000e1']::uuid[]
            FROM pickup_sessions WHERE id = 'a7000000-0000-0000-0000-0000000000f1') THEN
    RAISE EXCEPTION 'the rollback did not restore the pickup-pass tick';
  END IF;

  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000d9') <> 'checked_in' THEN
    RAISE EXCEPTION 'the rollback completed a pickup that still owes TE-2';
  END IF;
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000e2') IS NOT NULL THEN
    RAISE EXCEPTION 'the rollback stamped the owed sibling';
  END IF;

  RAISE NOTICE '0487 rollback: partial restore OK';
END $$;

-- ---------------------------------------------------------------------------
-- #798 finding 4 (legacy fallback): an audit row written before decided_at
-- existed has no decided_at in its removed outcomes; the restore must fall
-- back to created_at instead of inserting NULL.
-- ---------------------------------------------------------------------------

-- Reset the same line/bin/outcome to the state a fresh undo leaves.
DELETE FROM pickup_lot_outcomes
 WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000d9'
   AND lot_id = 'a7000000-0000-0000-0000-0000000000e1';
UPDATE invoice_lots SET picked_up_at = NULL
 WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000d1'
   AND lot_id = 'a7000000-0000-0000-0000-0000000000e1';
UPDATE bin_assignments SET status = 'staged', picked_up_at = NULL
 WHERE id = (
   SELECT id FROM bin_assignments
    WHERE lot_id = 'a7000000-0000-0000-0000-0000000000e1'
    ORDER BY assigned_at DESC, id DESC LIMIT 1);

-- Copy the real audit row but strip decided_at, like a pre-0487 audit.
WITH ins AS (
  INSERT INTO operator_audit_log
    (operator_id, actor_user_id, action_type, target_id, before_state,
     after_state, reason_note, created_at)
  SELECT a.operator_id, a.actor_user_id, a.action_type, a.target_id,
         jsonb_set(
           a.before_state,
           '{removed_collected_outcomes}',
           COALESCE((
             SELECT jsonb_agg(e - 'decided_at')
               FROM jsonb_array_elements(a.before_state->'removed_collected_outcomes') e
           ), '[]'::jsonb)),
         a.after_state, 'legacy audit replay', clock_timestamp()
    FROM operator_audit_log a
   WHERE a.id = current_setting('test.restore_audit_id')::bigint
  RETURNING id
)
SELECT id AS restore_audit_id FROM ins;
\gset
\set keep_function 1
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql

SELECT set_config('test.restore_audit_id', :'restore_audit_id', true);

DO $$
DECLARE
  v_legacy jsonb;
BEGIN
  SELECT before_state INTO v_legacy FROM operator_audit_log
   WHERE id = current_setting('test.restore_audit_id')::bigint;

  IF (SELECT decided_at FROM pickup_lot_outcomes
       WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000d9'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000e1')
     IS DISTINCT FROM
     (v_legacy->'removed_collected_outcomes'->0->>'created_at')::timestamptz THEN
    RAISE EXCEPTION 'the legacy restore did not fall back to created_at';
  END IF;

  RAISE NOTICE '0487 #798: legacy decided_at fallback OK';
END $$;

-- Single-line visit: undo TE-12; restoring it may put the pickup back to
-- 'completed' because nothing else is owed (and must not stamp anything else).
SELECT undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d6',
                                'a7000000-0000-0000-0000-0000000000ec',
                                'wrong lot scanned at the counter') AS undo_res;

SELECT a.id AS restore_audit_id
  FROM operator_audit_log a
 WHERE a.action_type = 'invoice_line.pickup_undone'
   AND a.target_id = 'a7000000-0000-0000-0000-0000000000d6'
   AND a.before_state->>'lot_id' = 'a7000000-0000-0000-0000-0000000000ec'
 ORDER BY a.created_at DESC
 LIMIT 1
\gset
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql

SELECT set_config('test.restore_audit_id', :'restore_audit_id', true);

DO $$
DECLARE
  v_before jsonb;
BEGIN
  SELECT before_state INTO v_before FROM operator_audit_log
   WHERE id = current_setting('test.restore_audit_id')::bigint;

  IF (SELECT picked_up_at FROM invoice_lots
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000ec')
     IS DISTINCT FROM (v_before->>'picked_up_at')::timestamptz THEN
    RAISE EXCEPTION 'the rollback did not restore the single-line stamp';
  END IF;
  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000dc') <> 'completed' THEN
    RAISE EXCEPTION 'the rollback did not restore the completed pickup';
  END IF;
  IF (SELECT completed_at FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000dc')
     IS DISTINCT FROM (v_before->>'pickup_completed_at')::timestamptz THEN
    RAISE EXCEPTION 'the rollback did not restore the prior completed_at';
  END IF;

  RAISE NOTICE '0487 rollback: completed restore OK';
END $$;

-- ---------------------------------------------------------------------------
-- MEDIUM: a refused restore is a complete no-op (line, bin, outcomes, ticks,
-- pickup). Two cases: the line was refunded after the undo, and the item was
-- moved / re-staged after the undo.
-- ---------------------------------------------------------------------------

-- A. undo → refund → restore. The line restore is refused, so the bin must not
--    be flipped back to picked_up either.
SELECT undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d7',
                                'a7000000-0000-0000-0000-0000000000ed',
                                'wrong lot scanned at the counter') AS undo_res;
UPDATE invoice_lots SET refunded_at = now()
 WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000d7'
   AND lot_id = 'a7000000-0000-0000-0000-0000000000ed';

SELECT a.id AS restore_audit_id
  FROM operator_audit_log a
 WHERE a.action_type = 'invoice_line.pickup_undone'
   AND a.target_id = 'a7000000-0000-0000-0000-0000000000d7'
   AND a.before_state->>'lot_id' = 'a7000000-0000-0000-0000-0000000000ed'
 ORDER BY a.created_at DESC
 LIMIT 1
\gset
\set keep_function 1
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql

DO $$
DECLARE
  v_bin uuid;
  v_picked timestamptz;
BEGIN
  SELECT (a.before_state->'bin_assignment'->>'id')::uuid,
         (a.before_state->'bin_assignment'->>'picked_up_at')::timestamptz
    INTO v_bin, v_picked
    FROM operator_audit_log a
   WHERE a.action_type = 'invoice_line.pickup_undone'
     AND a.target_id = 'a7000000-0000-0000-0000-0000000000d7'
     AND a.before_state->>'lot_id' = 'a7000000-0000-0000-0000-0000000000ed'
   ORDER BY a.created_at DESC
   LIMIT 1;

  IF (SELECT picked_up_at FROM invoice_lots
       WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000d7'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000ed') IS NOT NULL THEN
    RAISE EXCEPTION 'the refunded-line restore stamped the line anyway';
  END IF;
  IF (SELECT status::text FROM bin_assignments WHERE id = v_bin) <> 'staged' THEN
    RAISE EXCEPTION 'the refused restore mutated the bin status';
  END IF;
  IF (SELECT picked_up_at FROM bin_assignments WHERE id = v_bin) IS NOT NULL THEN
    RAISE EXCEPTION 'the refused restore mutated the bin timestamp';
  END IF;
  IF EXISTS (SELECT 1 FROM pickup_lot_outcomes
              WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000dd'
                AND lot_id = 'a7000000-0000-0000-0000-0000000000ed') THEN
    RAISE EXCEPTION 'the refused restore re-added the collected outcome';
  END IF;
  IF (SELECT collected_lot_ids @> ARRAY['a7000000-0000-0000-0000-0000000000ed']::uuid[]
        FROM pickup_sessions WHERE id = 'a7000000-0000-0000-0000-0000000000f1') THEN
    RAISE EXCEPTION 'the refused restore re-added the pickup-pass tick';
  END IF;
  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000dd') <> 'checked_in' THEN
    RAISE EXCEPTION 'the refused restore completed the pickup';
  END IF;

  RAISE NOTICE '0487 rollback: refunded-line refusal is a no-op';
END $$;

-- B. undo → move / re-stage → restore. The recorded bin row is no longer the
--    lot's current assignment, so nothing may move.
SELECT undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000d8',
                                'a7000000-0000-0000-0000-0000000000ee',
                                'wrong lot scanned at the counter') AS undo_res;
INSERT INTO bin_assignments (lot_id, bin_id, status, assigned_at, picked_up_at)
VALUES ('a7000000-0000-0000-0000-0000000000ee',
        'a7000000-0000-0000-0000-0000000000ba', 'staged',
        now() + interval '1 minute', NULL);

SELECT a.id AS restore_audit_id
  FROM operator_audit_log a
 WHERE a.action_type = 'invoice_line.pickup_undone'
   AND a.target_id = 'a7000000-0000-0000-0000-0000000000d8'
   AND a.before_state->>'lot_id' = 'a7000000-0000-0000-0000-0000000000ee'
 ORDER BY a.created_at DESC
 LIMIT 1
\gset
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql

DO $$
DECLARE
  v_bin uuid;
BEGIN
  SELECT (a.before_state->'bin_assignment'->>'id')::uuid
    INTO v_bin
    FROM operator_audit_log a
   WHERE a.action_type = 'invoice_line.pickup_undone'
     AND a.target_id = 'a7000000-0000-0000-0000-0000000000d8'
     AND a.before_state->>'lot_id' = 'a7000000-0000-0000-0000-0000000000ee'
   ORDER BY a.created_at DESC
   LIMIT 1;

  IF (SELECT picked_up_at FROM invoice_lots
       WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000d8'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000ee') IS NOT NULL THEN
    RAISE EXCEPTION 'the moved-bin restore stamped the line anyway';
  END IF;
  IF (SELECT status::text FROM bin_assignments WHERE id = v_bin) <> 'staged' THEN
    RAISE EXCEPTION 'the moved-bin restore flipped the old bin row';
  END IF;
  IF (SELECT picked_up_at FROM bin_assignments WHERE id = v_bin) IS NOT NULL THEN
    RAISE EXCEPTION 'the moved-bin restore stamped the old bin row';
  END IF;
  IF (SELECT status::text FROM bin_assignments
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000ee'
         AND bin_id = 'a7000000-0000-0000-0000-0000000000ba') <> 'staged' THEN
    RAISE EXCEPTION 'the moved-bin restore changed the current assignment';
  END IF;
  IF EXISTS (SELECT 1 FROM pickup_lot_outcomes
              WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000de'
                AND lot_id = 'a7000000-0000-0000-0000-0000000000ee') THEN
    RAISE EXCEPTION 'the moved-bin restore re-added the collected outcome';
  END IF;
  IF (SELECT collected_lot_ids @> ARRAY['a7000000-0000-0000-0000-0000000000ee']::uuid[]
        FROM pickup_sessions WHERE id = 'a7000000-0000-0000-0000-0000000000f1') THEN
    RAISE EXCEPTION 'the moved-bin restore re-added the pickup-pass tick';
  END IF;
  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000de') <> 'checked_in' THEN
    RAISE EXCEPTION 'the moved-bin restore completed the pickup';
  END IF;

  RAISE NOTICE '0487 rollback: moved-bin refusal is a no-op';
END $$;

-- A repeated audit id is the same no-op, even after the first refused run.
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql

DO $$
BEGIN
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000d8'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000ee') IS NOT NULL THEN
    RAISE EXCEPTION 'a repeated audit id restored the moved-bin line';
  END IF;
  IF (SELECT count(*) FROM bin_assignments
       WHERE lot_id = 'a7000000-0000-0000-0000-0000000000ee') <> 2 THEN
    RAISE EXCEPTION 'a repeated audit id changed the bin assignment count';
  END IF;

  RAISE NOTICE '0487 rollback: repeated audit id is a no-op';
END $$;

-- ---------------------------------------------------------------------------
-- #796 finding 2: a preflight snapshot cannot authorize a write later.
--
-- The rollback is one transaction, but a refund / move can commit between the
-- preflight and the writes when the recipe is run by a person. Both cases are
-- reproduced deterministically with the documented test hook: preflight-only,
-- mutate the world, then writes-only. A refused restore must change NOTHING.
-- ---------------------------------------------------------------------------

-- A. undo → preflight → concurrent refund → writes: complete no-op.
SELECT undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000f1',
                                'a7000000-0000-0000-0000-0000000000f6',
                                'wrong lot scanned at the counter') AS undo_res;

SELECT a.id AS restore_audit_id
  FROM operator_audit_log a
 WHERE a.action_type = 'invoice_line.pickup_undone'
   AND a.target_id = 'a7000000-0000-0000-0000-0000000000f1'
   AND a.before_state->>'lot_id' = 'a7000000-0000-0000-0000-0000000000f6'
 ORDER BY a.id DESC
 LIMIT 1
\gset
\set keep_function 1
\set restore_preflight_only 1
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql
\unset restore_preflight_only

UPDATE invoice_lots SET refunded_at = now()
 WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000f1'
   AND lot_id = 'a7000000-0000-0000-0000-0000000000f6';

\set restore_skip_preflight 1
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql
\unset restore_skip_preflight

DO $$
DECLARE
  v_bin uuid;
BEGIN
  SELECT (a.before_state->'bin_assignment'->>'id')::uuid INTO v_bin
    FROM operator_audit_log a
   WHERE a.action_type = 'invoice_line.pickup_undone'
     AND a.target_id = 'a7000000-0000-0000-0000-0000000000f1'
     AND a.before_state->>'lot_id' = 'a7000000-0000-0000-0000-0000000000f6'
   ORDER BY a.id DESC LIMIT 1;

  IF (SELECT picked_up_at FROM invoice_lots
       WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000f1'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000f6') IS NOT NULL THEN
    RAISE EXCEPTION 'the stale-preflight refund restore stamped the line';
  END IF;
  IF (SELECT status::text FROM bin_assignments WHERE id = v_bin) <> 'staged'
     OR (SELECT picked_up_at FROM bin_assignments WHERE id = v_bin) IS NOT NULL THEN
    RAISE EXCEPTION 'the stale-preflight refund restore flipped the bin row';
  END IF;
  IF EXISTS (SELECT 1 FROM pickup_lot_outcomes
              WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000fb'
                AND lot_id = 'a7000000-0000-0000-0000-0000000000f6') THEN
    RAISE EXCEPTION 'the stale-preflight refund restore re-added the outcome';
  END IF;
  IF (SELECT collected_lot_ids @> ARRAY['a7000000-0000-0000-0000-0000000000f6']::uuid[]
        FROM pickup_sessions WHERE id = 'a7000000-0000-0000-0000-0000000000f1') THEN
    RAISE EXCEPTION 'the stale-preflight refund restore re-added the tick';
  END IF;
  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000fb') <> 'checked_in'
     OR (SELECT completed_at FROM pickups
          WHERE id = 'a7000000-0000-0000-0000-0000000000fb') IS NOT NULL THEN
    RAISE EXCEPTION 'the stale-preflight refund restore completed the pickup';
  END IF;

  RAISE NOTICE '0487 rollback: stale-preflight refund is a no-op';
END $$;

-- B. undo → preflight → concurrent move/re-stage → writes: complete no-op.
SELECT undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000f2',
                                'a7000000-0000-0000-0000-0000000000f7',
                                'wrong lot scanned at the counter') AS undo_res;

SELECT a.id AS restore_audit_id
  FROM operator_audit_log a
 WHERE a.action_type = 'invoice_line.pickup_undone'
   AND a.target_id = 'a7000000-0000-0000-0000-0000000000f2'
   AND a.before_state->>'lot_id' = 'a7000000-0000-0000-0000-0000000000f7'
 ORDER BY a.id DESC
 LIMIT 1
\gset
\set keep_function 1
\set restore_preflight_only 1
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql
\unset restore_preflight_only

INSERT INTO bin_assignments (lot_id, bin_id, status, assigned_at, picked_up_at)
VALUES ('a7000000-0000-0000-0000-0000000000f7',
        'a7000000-0000-0000-0000-0000000000ba', 'staged',
        now() + interval '1 minute', NULL);

\set restore_skip_preflight 1
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql
\unset restore_skip_preflight

DO $$
DECLARE
  v_bin uuid;
BEGIN
  SELECT (a.before_state->'bin_assignment'->>'id')::uuid INTO v_bin
    FROM operator_audit_log a
   WHERE a.action_type = 'invoice_line.pickup_undone'
     AND a.target_id = 'a7000000-0000-0000-0000-0000000000f2'
     AND a.before_state->>'lot_id' = 'a7000000-0000-0000-0000-0000000000f7'
   ORDER BY a.id DESC LIMIT 1;

  IF (SELECT picked_up_at FROM invoice_lots
       WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000f2'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000f7') IS NOT NULL THEN
    RAISE EXCEPTION 'the stale-preflight move restore stamped the line';
  END IF;
  IF (SELECT status::text FROM bin_assignments WHERE id = v_bin) <> 'staged'
     OR (SELECT picked_up_at FROM bin_assignments WHERE id = v_bin) IS NOT NULL THEN
    RAISE EXCEPTION 'the stale-preflight move restore flipped the old bin row';
  END IF;
  IF EXISTS (SELECT 1 FROM pickup_lot_outcomes
              WHERE pickup_id = 'a7000000-0000-0000-0000-0000000000fc'
                AND lot_id = 'a7000000-0000-0000-0000-0000000000f7') THEN
    RAISE EXCEPTION 'the stale-preflight move restore re-added the outcome';
  END IF;
  IF (SELECT collected_lot_ids @> ARRAY['a7000000-0000-0000-0000-0000000000f7']::uuid[]
        FROM pickup_sessions WHERE id = 'a7000000-0000-0000-0000-0000000000f1') THEN
    RAISE EXCEPTION 'the stale-preflight move restore re-added the tick';
  END IF;
  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000fc') <> 'checked_in' THEN
    RAISE EXCEPTION 'the stale-preflight move restore completed the pickup';
  END IF;

  RAISE NOTICE '0487 rollback: stale-preflight move is a no-op';
END $$;

-- C. replaying an OLD undo after a NEWER undo of the same line is refused.
SELECT undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000c5',
                                'a7000000-0000-0000-0000-0000000000c6',
                                'wrong lot scanned at the counter') AS undo_res;

SELECT a.id AS restore_audit_id
  FROM operator_audit_log a
 WHERE a.action_type = 'invoice_line.pickup_undone'
   AND a.target_id = 'a7000000-0000-0000-0000-0000000000c5'
   AND a.before_state->>'lot_id' = 'a7000000-0000-0000-0000-0000000000c6'
 ORDER BY a.id ASC
 LIMIT 1
\gset

-- A later handover, then a second undo: the first audit is now historical.
UPDATE invoice_lots SET picked_up_at = now()
 WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000c5'
   AND lot_id = 'a7000000-0000-0000-0000-0000000000c6';
SELECT undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000c5',
                                'a7000000-0000-0000-0000-0000000000c6',
                                'second wrong lot scan') AS undo_res;

\set keep_function 1
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql

DO $$
BEGIN
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000c5'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000c6') IS NOT NULL THEN
    RAISE EXCEPTION 'an old audit row restored a line undone again later';
  END IF;

  RAISE NOTICE '0487 rollback: old-audit replay is a no-op';
END $$;

-- ---------------------------------------------------------------------------
-- #796 finding 3: the staff and manager RPCs must not announce a completion
-- the 0487 guard refused.
--
-- A real undo committing between the RPC's owed-count and its pickups UPDATE
-- is reproduced deterministically: this test-only BEFORE trigger runs first
-- (name order) and clears the line, exactly the state a committed undo leaves.
-- The RPC must then read the persisted row back, return a partial result and
-- queue no pickup_confirmed notification.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _test_0487_clear_line_on_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed'
     AND current_setting('test.race_0487_invoice', true) = NEW.invoice_id::text THEN
    UPDATE invoice_lots
       SET picked_up_at = NULL
     WHERE invoice_id = NEW.invoice_id
       AND lot_id = current_setting('test.race_0487_lot', true)::uuid;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER aaa_test_0487_clear_line_on_complete
  BEFORE UPDATE OF status ON pickups
  FOR EACH ROW
  EXECUTE FUNCTION _test_0487_clear_line_on_complete();

DO $$
DECLARE
  v_staff_res staff_confirm_pickup_result;
  v_mgr_res   jsonb;
BEGIN
  PERFORM set_config('test.uid', 'a7000000-0000-0000-0000-0000000000c1', true);

  -- ── staff_confirm_pickup ────────────────────────────────────────────────
  PERFORM undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000f3',
                                   'a7000000-0000-0000-0000-0000000000f8',
                                   'wrong lot scanned at the counter');
  -- Put the line back so the RPC's count sees nothing owed; an undo audit now
  -- exists, so the guard will refuse once the test trigger clears it.
  UPDATE invoice_lots SET picked_up_at = now()
   WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000f3'
     AND lot_id = 'a7000000-0000-0000-0000-0000000000f8';

  PERFORM set_config('test.race_0487_invoice',
                     'a7000000-0000-0000-0000-0000000000f3', true);
  PERFORM set_config('test.race_0487_lot',
                     'a7000000-0000-0000-0000-0000000000f8', true);

  v_staff_res := staff_confirm_pickup(
    'a7000000-0000-0000-0000-0000000000f3',
    ARRAY['TE-18']::text[], TRUE);

  PERFORM set_config('test.race_0487_invoice', '', true);
  PERFORM set_config('test.race_0487_lot', '', true);

  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000fd') <> 'checked_in' THEN
    RAISE EXCEPTION 'staff_confirm_pickup persisted a refused completion';
  END IF;
  IF (SELECT completed_at FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000fd') IS NOT NULL THEN
    RAISE EXCEPTION 'staff_confirm_pickup kept completed_at on a refusal';
  END IF;
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000f3'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000f8') IS NOT NULL THEN
    RAISE EXCEPTION 'staff_confirm_pickup stamped an owed undone line';
  END IF;
  IF v_staff_res.out_warning IS NULL OR v_staff_res.out_warning NOT LIKE '%partial%' THEN
    RAISE EXCEPTION 'staff_confirm_pickup did not report the refusal (warning %)',
      v_staff_res.out_warning;
  END IF;
  IF EXISTS (SELECT 1 FROM notifications_outbox
              WHERE idempotency_key = 'pickup_confirmed:staff:a7000000-0000-0000-0000-0000000000f3') THEN
    RAISE EXCEPTION 'staff_confirm_pickup queued a completion notification anyway';
  END IF;

  -- ── manager_pickup_override ─────────────────────────────────────────────
  PERFORM undo_invoice_line_pickup('a7000000-0000-0000-0000-0000000000f4',
                                   'a7000000-0000-0000-0000-0000000000f9',
                                   'wrong lot scanned at the counter');
  UPDATE invoice_lots SET picked_up_at = now()
   WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000f4'
     AND lot_id = 'a7000000-0000-0000-0000-0000000000f9';

  PERFORM set_config('test.race_0487_invoice',
                     'a7000000-0000-0000-0000-0000000000f4', true);
  PERFORM set_config('test.race_0487_lot',
                     'a7000000-0000-0000-0000-0000000000f9', true);

  v_mgr_res := manager_pickup_override(
    'a7000000-0000-0000-0000-0000000000f4',
    ARRAY['a7000000-0000-0000-0000-0000000000f9']::uuid[],
    'system_glitch', NULL);

  PERFORM set_config('test.race_0487_invoice', '', true);
  PERFORM set_config('test.race_0487_lot', '', true);

  IF v_mgr_res->>'pickup_completed' <> 'false' THEN
    RAISE EXCEPTION 'manager_pickup_override reported a refused completion (got %)', v_mgr_res;
  END IF;
  IF (v_mgr_res->>'remaining_count')::int < 1 THEN
    RAISE EXCEPTION 'manager_pickup_override hid the remaining owed line (got %)', v_mgr_res;
  END IF;
  IF (SELECT status::text FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000fe') <> 'checked_in' THEN
    RAISE EXCEPTION 'manager_pickup_override persisted a refused completion';
  END IF;
  IF (SELECT completed_at FROM pickups
       WHERE id = 'a7000000-0000-0000-0000-0000000000fe') IS NOT NULL THEN
    RAISE EXCEPTION 'manager_pickup_override kept completed_at on a refusal';
  END IF;
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE invoice_id = 'a7000000-0000-0000-0000-0000000000f4'
         AND lot_id = 'a7000000-0000-0000-0000-0000000000f9') IS NOT NULL THEN
    RAISE EXCEPTION 'manager_pickup_override stamped an owed undone line';
  END IF;
  IF EXISTS (SELECT 1 FROM notifications_outbox
              WHERE idempotency_key = 'pickup_confirmed:staff:a7000000-0000-0000-0000-0000000000f4') THEN
    RAISE EXCEPTION 'manager_pickup_override queued a completion notification anyway';
  END IF;
  IF (SELECT after_state->>'pickup_completed' FROM operator_audit_log
       WHERE action_type = 'pickup.manager_override'
         AND target_id = 'a7000000-0000-0000-0000-0000000000f4'
       ORDER BY id DESC LIMIT 1) <> 'false' THEN
    RAISE EXCEPTION 'manager_pickup_override audited the refusal as a completion';
  END IF;

  RAISE NOTICE '0487 #796: refused completions announce nothing';
END $$;

DROP TRIGGER aaa_test_0487_clear_line_on_complete ON pickups;
DROP FUNCTION _test_0487_clear_line_on_complete();


ROLLBACK;
