-- Behavioural test for mig 0356 (and the 0355 behaviour it must keep).
-- Plain-psql assertions, no pgTAP (matches relist_refunded_child_guard.sql).
--
-- The incident: a customer carries an item out of the building, the system
-- later forfeits and relists it, and a second buyer wins a box that is not
-- there. Audit: docs/audits/flagged-items-pickup-forfeit-relist-2026-09-14.md.
--
-- Pinned here, in both directions:
--   A. relist guard — direct parent stamped         -> BLOCKED (0355, kept)
--   B. relist guard — GRANDPARENT stamped, child unsold -> BLOCKED (0356, new)
--   C. B + a put-away scan of the box after the stamp   -> ALLOWED (the escape)
--      C2/C3: the child's own birth location event does NOT clear; a later scan does
--   D. stamped then line refunded / invoice refunded    -> ALLOWED (returns)
--   E. never collected                                  -> ALLOWED
--   F. customer tick only (pickup pass)                 -> BLOCKED with its own code
--   G. F + put-away scan after the visit                -> ALLOWED
--   H. tick on the grandparent                          -> BLOCKED
--   I. late pickup: stamping a line on an 'unsold' lot with no child -> lot 'won'
--   J. late pickup on an 'unsold' lot that HAS a live child          -> stays 'unsold'
--   K. stamping a line on a 'won' / 'relisted' lot                    -> unchanged
--   L. pickup -> completed stamps open lines; leaves refunded, missing,
--      left_behind and already-stamped lines alone; stamps a forfeited line
--   M. the sweep replay: a partial pickup past its window — the two items the
--      customer took stay 'won', the third goes 'unsold', and only the third
--      can be relisted (end to end through auto_mark_pickup_no_show).
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code, pickup_grace_extension_hours)
VALUES ('c0110000-0000-0000-0000-000000000001', 'neverresold', 'Never Resold Co', 'nr@example.com', 'NRS', 0);

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('c0110000-0000-0000-0000-000000000002', 'c0110000-0000-0000-0000-000000000001',
        'NRS WH', '1 Never St', 'Harrison', 'AR', '72601');

-- A shelf, so a relist child can be born with intake_bin_id (which makes the
-- lots_log_intake_move trigger write its birth location event, as on prod).
INSERT INTO bins (id, warehouse_id, code, aisle, x_px, y_px)
VALUES ('c0110000-0000-0000-0000-000000000006', 'c0110000-0000-0000-0000-000000000002', 'NRS-1-01-01', '1', 0, 0);

-- Target auction for relists (draft, in the future).
INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('c0110000-0000-0000-0000-000000000003', 'c0110000-0000-0000-0000-000000000001',
        'c0110000-0000-0000-0000-000000000002', 'NRS target', 'draft',
        now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('c0110000-0000-0000-0000-000000000005', 'nr-bidder@example.com');
INSERT INTO bidders (id, email, birth_date)
VALUES ('c0110000-0000-0000-0000-000000000005', 'nr-bidder@example.com', DATE '1990-01-01');

-- Helpers -------------------------------------------------------------------

-- invoices are UNIQUE (auction_id, bidder_id), so every invoice gets its own
-- closed auction whose pickup window ended two days ago (the sweep replay in
-- M needs a past deadline; the guard cases do not care).
CREATE FUNCTION pg_temp.mk_invoice(p_status invoice_status DEFAULT 'paid')
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v UUID; a UUID;
BEGIN
  INSERT INTO auctions (operator_id, warehouse_id, title, status,
                        starts_at, ends_at, pickup_starts_at, pickup_ends_at)
  VALUES ('c0110000-0000-0000-0000-000000000001', 'c0110000-0000-0000-0000-000000000002',
          'NRS closed ' || gen_random_uuid()::text, 'closed',
          now() - interval '10 days', now() - interval '8 days',
          now() - interval '7 days', now() - interval '2 days')
  RETURNING id INTO a;
  INSERT INTO invoices (operator_id, auction_id, bidder_id, status)
  VALUES ('c0110000-0000-0000-0000-000000000001', a, 'c0110000-0000-0000-0000-000000000005', p_status)
  RETURNING id INTO v;
  RETURN v;
END $$;

CREATE FUNCTION pg_temp.mk_lot(p_code TEXT, p_status lot_status, p_parent UUID DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v UUID;
BEGIN
  INSERT INTO lots (operator_id, warehouse_id, lot_code, title, status, relisted_from_lot_id, relist_count)
  VALUES ('c0110000-0000-0000-0000-000000000001', 'c0110000-0000-0000-0000-000000000002',
          p_code, 'never-resold fixture', p_status, p_parent, CASE WHEN p_parent IS NULL THEN 0 ELSE 1 END)
  RETURNING id INTO v;
  RETURN v;
END $$;

-- A line on a fresh invoice, optionally stamped/refunded, with a pending pickup.
CREATE FUNCTION pg_temp.mk_line(p_lot UUID, p_picked_up TIMESTAMPTZ DEFAULT NULL, p_refunded TIMESTAMPTZ DEFAULT NULL,
                                p_invoice_status invoice_status DEFAULT 'paid', p_pickup_status pickup_status DEFAULT 'forfeited')
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_inv UUID;
BEGIN
  v_inv := pg_temp.mk_invoice(p_invoice_status);
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at, refunded_at)
  VALUES (v_inv, p_lot, 1000, p_picked_up, p_refunded);
  INSERT INTO pickups (invoice_id, warehouse_id, status)
  VALUES (v_inv, 'c0110000-0000-0000-0000-000000000002', p_pickup_status);
  RETURN v_inv;
END $$;

-- Relist attempt: 'ALLOWED', or the error code (text before the first colon).
CREATE FUNCTION pg_temp.try_relist(p_lot UUID) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v UUID;
BEGIN
  v := relist_lot_into_auction(p_lot, 'c0110000-0000-0000-0000-000000000003');
  RETURN CASE WHEN v IS NULL THEN 'NULL' ELSE 'ALLOWED' END;
EXCEPTION WHEN OTHERS THEN
  RETURN split_part(SQLERRM, ':', 1);
END $$;

CREATE FUNCTION pg_temp.lot_status(p_lot UUID) RETURNS TEXT LANGUAGE sql AS $$
  SELECT status::text FROM lots WHERE id = p_lot $$;

-- Failure accumulator.
CREATE TEMP TABLE _fail (msg TEXT);
CREATE FUNCTION pg_temp.expect(p_label TEXT, p_got TEXT, p_want TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    INSERT INTO _fail VALUES (format('%s -> got %s, expected %s', p_label, coalesce(p_got,'NULL'), p_want));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- A–H: the relist guard
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  gp UUID; par UUID; ch UUID; inv UUID; t0 TIMESTAMPTZ := now() - interval '5 days';
BEGIN
  -- A. direct parent stamped, unrefunded, unsold (the 0355 shape) -> BLOCKED
  par := pg_temp.mk_lot('NRS-A', 'unsold');
  PERFORM pg_temp.mk_line(par, t0);
  PERFORM pg_temp.expect('A direct parent stamped', pg_temp.try_relist(par), 'relist_blocked_item_collected');

  -- B. grandparent stamped; parent is its (pre-0355) relist child, now unsold -> BLOCKED
  -- The children are minted BEFORE the stamp lands, as they were on prod
  -- (0355 did not exist when they were relisted); the guard itself would
  -- refuse to mint them afterwards, which case B3 pins.
  gp  := pg_temp.mk_lot('NRS-B-GP', 'relisted');
  par := pg_temp.mk_lot('NRS-B-CH', 'unsold', gp);
  ch  := pg_temp.mk_lot('NRS-B-GCH', 'unsold', par);
  PERFORM pg_temp.mk_line(gp, t0);
  PERFORM pg_temp.expect('B grandparent stamped, child unsold', pg_temp.try_relist(par), 'relist_blocked_item_collected');

  -- B2. same, three generations deep -> BLOCKED
  PERFORM pg_temp.expect('B2 great-grandparent stamped', pg_temp.try_relist(ch), 'relist_blocked_item_collected');

  -- B3. minting ANY new descendant of a collected ancestor is refused at the table
  BEGIN
    PERFORM pg_temp.mk_lot('NRS-B3', 'in_inventory', ch);
    PERFORM pg_temp.expect('B3 direct insert of a descendant', 'ALLOWED', 'relist_blocked_item_collected');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.expect('B3 direct insert of a descendant', split_part(SQLERRM, ':', 1), 'relist_blocked_item_collected');
  END;

  -- C. B + a put-away scan of the box (recorded under the CHILD's code) after the stamp -> ALLOWED
  INSERT INTO lot_location_events (lot_id, kind, occurred_at) VALUES (par, 'intake', now() + interval '10 minutes');  -- a scan after the row exists
  PERFORM pg_temp.expect('C put back on a shelf since', pg_temp.try_relist(par), 'ALLOWED');

  -- C2. the relist child's OWN birth event must not clear the block.
  --     relist_lot_into_auction copies intake_bin_id to the child and the
  --     intake-move trigger logs a location event at creation; on prod 18 of
  --     19 ghost children would have slipped through on that artefact.
  gp := pg_temp.mk_lot('NRS-C2-GP', 'relisted');
  INSERT INTO lots (operator_id, warehouse_id, lot_code, title, status, relisted_from_lot_id, relist_count, intake_bin_id)
  VALUES ('c0110000-0000-0000-0000-000000000001', 'c0110000-0000-0000-0000-000000000002',
          'NRS-C2-CH', 'never-resold fixture', 'unsold', gp, 1, 'c0110000-0000-0000-0000-000000000006')
  RETURNING id INTO par;
  PERFORM pg_temp.expect('C2 fixture: child born with a location event',
    (SELECT count(*) FROM lot_location_events WHERE lot_id = par)::text, '1');
  PERFORM pg_temp.mk_line(gp, t0);                 -- stamp predates the birth event
  PERFORM pg_temp.expect('C2 birth event does not clear', pg_temp.try_relist(par), 'relist_blocked_item_collected');

  -- C3. ...but a real Put-away scan later does.
  INSERT INTO lot_location_events (lot_id, bin_id, kind, occurred_at)
  VALUES (par, 'c0110000-0000-0000-0000-000000000006', 'intake', now() + interval '10 minutes');
  PERFORM pg_temp.expect('C3 later scan clears', pg_temp.try_relist(par), 'ALLOWED');

  -- D. stamped then the LINE refunded -> ALLOWED (a counter return)
  par := pg_temp.mk_lot('NRS-D1', 'unsold');
  PERFORM pg_temp.mk_line(par, t0, t0 + interval '1 hour');
  PERFORM pg_temp.expect('D1 stamped then line refunded', pg_temp.try_relist(par), 'ALLOWED');

  -- D2. stamped, line NOT stamped refunded but whole INVOICE refunded -> ALLOWED
  par := pg_temp.mk_lot('NRS-D2', 'unsold');
  PERFORM pg_temp.mk_line(par, t0, NULL, 'refunded');
  PERFORM pg_temp.expect('D2 stamped, whole invoice refunded', pg_temp.try_relist(par), 'ALLOWED');

  -- D3. grandparent stamped-and-refunded, child unsold -> ALLOWED
  gp  := pg_temp.mk_lot('NRS-D3-GP', 'relisted');
  par := pg_temp.mk_lot('NRS-D3-CH', 'unsold', gp);
  PERFORM pg_temp.mk_line(gp, t0, t0 + interval '1 hour');
  PERFORM pg_temp.expect('D3 grandparent refunded', pg_temp.try_relist(par), 'ALLOWED');

  -- E. never collected -> ALLOWED
  par := pg_temp.mk_lot('NRS-E', 'unsold');
  PERFORM pg_temp.mk_line(par, NULL);
  PERFORM pg_temp.expect('E never collected', pg_temp.try_relist(par), 'ALLOWED');

  -- F. customer tick only -> BLOCKED with the soft code
  par := pg_temp.mk_lot('NRS-F', 'unsold');
  PERFORM pg_temp.mk_line(par, NULL);
  INSERT INTO pickup_sessions (bidder_id, collected_lot_ids, created_at, status)
  VALUES ('c0110000-0000-0000-0000-000000000005', ARRAY[par], t0, 'completed');
  PERFORM pg_temp.expect('F customer tick only', pg_temp.try_relist(par), 'relist_blocked_item_ticked_collected');

  -- G. F + put-away scan after the visit -> ALLOWED
  INSERT INTO lot_location_events (lot_id, kind, occurred_at) VALUES (par, 'intake', now() + interval '10 minutes');
  PERFORM pg_temp.expect('G tick then put back', pg_temp.try_relist(par), 'ALLOWED');

  -- G2. tick, but the line was refunded -> ALLOWED
  par := pg_temp.mk_lot('NRS-G2', 'unsold');
  PERFORM pg_temp.mk_line(par, NULL, t0 + interval '1 hour');
  INSERT INTO pickup_sessions (bidder_id, collected_lot_ids, created_at, status)
  VALUES ('c0110000-0000-0000-0000-000000000005', ARRAY[par], t0, 'completed');
  PERFORM pg_temp.expect('G2 tick but refunded', pg_temp.try_relist(par), 'ALLOWED');

  -- H. tick on the grandparent -> child BLOCKED (child minted before the tick, as on prod)
  gp  := pg_temp.mk_lot('NRS-H-GP', 'relisted');
  par := pg_temp.mk_lot('NRS-H-CH', 'unsold', gp);
  PERFORM pg_temp.mk_line(gp, NULL);
  INSERT INTO pickup_sessions (bidder_id, collected_lot_ids, created_at, status)
  VALUES ('c0110000-0000-0000-0000-000000000005', ARRAY[gp], t0, 'completed');
  PERFORM pg_temp.expect('H tick on grandparent', pg_temp.try_relist(par), 'relist_blocked_item_ticked_collected');

  -- H2. stamped beats ticked in the message when both exist
  gp  := pg_temp.mk_lot('NRS-H2', 'unsold');
  PERFORM pg_temp.mk_line(gp, t0);
  INSERT INTO pickup_sessions (bidder_id, collected_lot_ids, created_at, status)
  VALUES ('c0110000-0000-0000-0000-000000000005', ARRAY[gp], t0, 'completed');
  PERFORM pg_temp.expect('H2 stamped outranks tick', pg_temp.try_relist(gp), 'relist_blocked_item_collected');
END $$;

-- ---------------------------------------------------------------------------
-- I–K: a late pickup restores 'won'
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  a UUID; b UUID; b_child UUID; c UUID; d UUID; inv UUID;
BEGIN
  -- I. unsold, no child, line gets stamped -> 'won'
  a := pg_temp.mk_lot('NRS-I', 'unsold');
  inv := pg_temp.mk_line(a, NULL);
  UPDATE invoice_lots SET picked_up_at = now() WHERE invoice_id = inv AND lot_id = a;
  PERFORM pg_temp.expect('I late pickup restores won', pg_temp.lot_status(a), 'won');

  -- I2. after the restore, a relist attempt is refused (owned again)
  PERFORM pg_temp.expect('I2 restored lot not relistable', pg_temp.try_relist(a), 'relist_source_wrong_status');

  -- J. unsold WITH a live child -> stays unsold (a person must untangle it)
  b := pg_temp.mk_lot('NRS-J', 'unsold');
  b_child := pg_temp.mk_lot('NRS-J-CH', 'in_inventory', b);
  inv := pg_temp.mk_line(b, NULL);
  UPDATE invoice_lots SET picked_up_at = now() WHERE invoice_id = inv AND lot_id = b;
  PERFORM pg_temp.expect('J unsold with live child stays', pg_temp.lot_status(b), 'unsold');

  -- J2. ...but a CANCELED child does not count
  UPDATE lots SET status = 'canceled', canceled_at = now() WHERE id = b_child;
  c := pg_temp.mk_lot('NRS-J2', 'unsold');
  b_child := pg_temp.mk_lot('NRS-J2-CH', 'canceled', c);
  UPDATE lots SET canceled_at = now() WHERE id = b_child;
  inv := pg_temp.mk_line(c, NULL);
  UPDATE invoice_lots SET picked_up_at = now() WHERE invoice_id = inv AND lot_id = c;
  PERFORM pg_temp.expect('J2 canceled child ignored', pg_temp.lot_status(c), 'won');

  -- K. 'won' and 'relisted' lots are untouched by a stamp
  d := pg_temp.mk_lot('NRS-K1', 'won');
  inv := pg_temp.mk_line(d, NULL, NULL, 'paid', 'pending');
  UPDATE invoice_lots SET picked_up_at = now() WHERE invoice_id = inv AND lot_id = d;
  PERFORM pg_temp.expect('K1 won unchanged', pg_temp.lot_status(d), 'won');
  d := pg_temp.mk_lot('NRS-K2', 'relisted');
  inv := pg_temp.mk_line(d, NULL);
  UPDATE invoice_lots SET picked_up_at = now() WHERE invoice_id = inv AND lot_id = d;
  PERFORM pg_temp.expect('K2 relisted unchanged', pg_temp.lot_status(d), 'relisted');

  -- K3. re-stamping an already-stamped line (no transition) does nothing
  d := pg_temp.mk_lot('NRS-K3', 'unsold');
  inv := pg_temp.mk_line(d, now() - interval '1 day');
  UPDATE lots SET status = 'unsold' WHERE id = d;   -- pretend a later sweep put it back
  UPDATE invoice_lots SET picked_up_at = now() WHERE invoice_id = inv AND lot_id = d;
  PERFORM pg_temp.expect('K3 no transition, no flip', pg_temp.lot_status(d), 'unsold');
END $$;

-- ---------------------------------------------------------------------------
-- L: completing a pickup stamps what it handed over
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  inv UUID; pk UUID; t_done TIMESTAMPTZ := now() - interval '1 hour'; t_old TIMESTAMPTZ := now() - interval '3 days';
  l_open UUID; l_ref UUID; l_forf UUID; l_miss UUID; l_later UUID; l_done UUID;
  v TIMESTAMPTZ;
BEGIN
  inv := pg_temp.mk_invoice('paid');
  l_open  := pg_temp.mk_lot('NRS-L-open', 'won');
  l_ref   := pg_temp.mk_lot('NRS-L-ref', 'won');
  l_forf  := pg_temp.mk_lot('NRS-L-forf', 'unsold');   -- sweep had reclaimed it
  l_miss  := pg_temp.mk_lot('NRS-L-miss', 'won');
  l_later := pg_temp.mk_lot('NRS-L-later', 'won');
  l_done  := pg_temp.mk_lot('NRS-L-done', 'won');
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at, refunded_at, forfeited_at) VALUES
    (inv, l_open, 1000, NULL, NULL, NULL),
    (inv, l_ref,  1000, NULL, t_old, NULL),
    (inv, l_forf, 1000, NULL, NULL, t_old),
    (inv, l_miss, 1000, NULL, NULL, NULL),
    (inv, l_later,1000, NULL, NULL, NULL),
    (inv, l_done, 1000, t_old, NULL, NULL);
  INSERT INTO pickups (invoice_id, warehouse_id, status)
  VALUES (inv, 'c0110000-0000-0000-0000-000000000002', 'no_show') RETURNING id INTO pk;
  INSERT INTO pickup_lot_outcomes (pickup_id, lot_id, outcome) VALUES (pk, l_miss, 'missing'), (pk, l_later, 'left_behind');

  -- the console / session page path: status flips, nothing else written
  UPDATE pickups SET status = 'completed', completed_at = t_done WHERE id = pk;

  SELECT picked_up_at INTO v FROM invoice_lots WHERE invoice_id = inv AND lot_id = l_open;
  PERFORM pg_temp.expect('L open line stamped with completed_at', v::text, t_done::text);
  SELECT picked_up_at INTO v FROM invoice_lots WHERE invoice_id = inv AND lot_id = l_ref;
  PERFORM pg_temp.expect('L refunded line untouched', v::text, NULL);
  SELECT picked_up_at INTO v FROM invoice_lots WHERE invoice_id = inv AND lot_id = l_forf;
  PERFORM pg_temp.expect('L forfeited line stamped (late visit closed)', v::text, t_done::text);
  PERFORM pg_temp.expect('L forfeited lot restored to won', pg_temp.lot_status(l_forf), 'won');
  SELECT picked_up_at INTO v FROM invoice_lots WHERE invoice_id = inv AND lot_id = l_miss;
  PERFORM pg_temp.expect('L missing line untouched', v::text, NULL);
  SELECT picked_up_at INTO v FROM invoice_lots WHERE invoice_id = inv AND lot_id = l_later;
  PERFORM pg_temp.expect('L left_behind line untouched', v::text, NULL);
  SELECT picked_up_at INTO v FROM invoice_lots WHERE invoice_id = inv AND lot_id = l_done;
  PERFORM pg_temp.expect('L already-stamped line keeps its time', v::text, t_old::text);

  -- re-touching a completed pickup does not move anything
  UPDATE pickups SET status = 'completed', completed_at = now() WHERE id = pk;
  SELECT picked_up_at INTO v FROM invoice_lots WHERE invoice_id = inv AND lot_id = l_open;
  PERFORM pg_temp.expect('L re-touch does not restamp', v::text, t_done::text);

  -- a non-completion transition stamps nothing
  inv := pg_temp.mk_invoice('paid');
  l_open := pg_temp.mk_lot('NRS-L2', 'won');
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents) VALUES (inv, l_open, 1000);
  INSERT INTO pickups (invoice_id, warehouse_id, status) VALUES (inv, 'c0110000-0000-0000-0000-000000000002', 'pending') RETURNING id INTO pk;
  UPDATE pickups SET status = 'checked_in' WHERE id = pk;
  SELECT picked_up_at INTO v FROM invoice_lots WHERE invoice_id = inv AND lot_id = l_open;
  PERFORM pg_temp.expect('L2 checked_in stamps nothing', v::text, NULL);
END $$;

-- ---------------------------------------------------------------------------
-- M: the sweep replay — partial pickup past its window
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  inv UUID; pk UUID; took1 UUID; took2 UUID; stayed UUID; r JSONB;
BEGIN
  inv := pg_temp.mk_invoice('paid');                    -- its auction's pickup window closed 2 days ago
  took1 := pg_temp.mk_lot('NRS-M-took1', 'won');        -- staff stamped it
  took2 := pg_temp.mk_lot('NRS-M-took2', 'won');        -- only the customer ticked it
  stayed  := pg_temp.mk_lot('NRS-M-left',  'won');        -- never collected
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at) VALUES
    (inv, took1, 1000, now() - interval '3 days'),
    (inv, took2, 1000, NULL),
    (inv, stayed,  1000, NULL);
  INSERT INTO pickups (invoice_id, warehouse_id, status, checked_in_at)
  VALUES (inv, 'c0110000-0000-0000-0000-000000000002', 'checked_in', now() - interval '3 days') RETURNING id INTO pk;
  INSERT INTO pickup_sessions (bidder_id, collected_lot_ids, created_at, status)
  VALUES ('c0110000-0000-0000-0000-000000000005', ARRAY[took2], now() - interval '3 days', 'completed');

  r := auto_mark_pickup_no_show();

  PERFORM pg_temp.expect('M pickup swept', ((SELECT status::text FROM pickups WHERE id = pk) IN ('no_show','forfeited'))::text, 'true');
  PERFORM pg_temp.expect('M stamped item stays won',  pg_temp.lot_status(took1), 'won');
  PERFORM pg_temp.expect('M ticked item stays won',   pg_temp.lot_status(took2), 'won');
  PERFORM pg_temp.expect('M uncollected item unsold', pg_temp.lot_status(stayed),  'unsold');
  PERFORM pg_temp.expect('M uncollected line forfeited', (SELECT forfeited_at IS NOT NULL FROM invoice_lots WHERE invoice_id = inv AND lot_id = stayed)::text, 'true');
  PERFORM pg_temp.expect('M stamped line NOT forfeited', (SELECT forfeited_at IS NULL FROM invoice_lots WHERE invoice_id = inv AND lot_id = took1)::text, 'true');

  -- only the item still on the shelf can go back to auction
  PERFORM pg_temp.expect('M relist uncollected', pg_temp.try_relist(stayed), 'ALLOWED');
  PERFORM pg_temp.expect('M relist stamped refused', (pg_temp.try_relist(took1) <> 'ALLOWED')::text, 'true');
  PERFORM pg_temp.expect('M relist ticked refused',  (pg_temp.try_relist(took2) <> 'ALLOWED')::text, 'true');

  -- 0358: a hand-edit of the collected lot back to unsold is skipped at the
  -- table and recorded in invariant_violations (before 0358 this UPDATE
  -- succeeded and only the relist guard stood between the row and the auction).
  UPDATE lots SET status = 'unsold' WHERE id = took1;
  PERFORM pg_temp.expect('M hand-edit to unsold skipped (0358)', pg_temp.lot_status(took1), 'won');
  PERFORM pg_temp.expect('M hand-edit recorded (0358)',
    (SELECT count(*) FROM invariant_violations WHERE lot_id = took1 AND check_code = 'collected_lot_reclaim_refused' AND resolved_at IS NULL)::text, '1');
  PERFORM pg_temp.expect('M relist still refused', (pg_temp.try_relist(took1) <> 'ALLOWED')::text, 'true');
END $$;

-- ---------------------------------------------------------------------------
-- Verdict
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_fail TEXT; v_n INT;
BEGIN
  SELECT string_agg(E'\n  ' || msg, ''), count(*) INTO v_fail, v_n FROM _fail;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'collected_item_never_resold: % assertion(s) failed:%', v_n, v_fail;
  END IF;
  RAISE NOTICE 'collected_item_never_resold: all cases OK';
END $$;

ROLLBACK;
