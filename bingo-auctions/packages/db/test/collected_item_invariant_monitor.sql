-- Behavioural test for migs 0357 (invariant monitor) and 0358 (reclaim guard).
-- Plain-psql assertions, no pgTAP (matches collected_item_never_resold.sql).
--
-- The invariant: a lot already handed to a buyer is never reclaimed, relisted,
-- or promised to a second buyer. Audit:
-- docs/audits/flagged-items-pickup-forfeit-relist-2026-09-14.md.
--
-- Every detector case BREAKS the guard that normally prevents the state
-- (trigger disabled inside this rolled-back transaction, exactly as a dropped
-- trigger or a bypassing backfill would) and confirms the monitor reports it,
-- then applies the real-world remediation and confirms the row resolves.
--
--   G. 0358 reclaim guard (skips the row and records it; never aborts)
--      G1 stamped lot won -> unsold / in_inventory            REFUSED (recorded once, refusals=2)
--      G2 line refunded                                       allowed
--      G3 invoice refunded                                    allowed
--      G4 birth-time location event does not clear; a later scan does
--      G5 never collected                                     allowed
--      G6 unsold -> in_inventory (already stock)              allowed
--      G7 won -> canceled (not stock)                         allowed
--      G8 a put-away scan on a relist CHILD clears the parent allowed
--   S. the no-show sweep
--      S1 guarded sweep (0351) succeeds; the trigger is never reached
--      S2 with the 0351 guard patched out, the 0358 trigger skips the
--         stamped lot, records the attempt, and the REST of the tick
--         completes: pickup swept, other lot reclaimed, audit row written
--   D. the monitor (check_collected_item_invariants)
--      D0 baseline (runs first): nothing unacknowledged at start (the 0357 seed)
--      D1 collected_lot_reclaimed: flagged / idempotent / resolves when restored
--         or refunded / reopens and is news again on recurrence
--      D2 collected_lineage_relisted: child AND grandchild flagged; the
--         grandchild also as ghost_child_relistable; all resolve on a scan
--      D3 collected_lineage_ticked_relisted: watch severity; resolves on refund
--      D4 second_buyer_promise (+ ticked variant): resolves when the second
--         line is refunded or forfeited
--      D5 ghost_child_relistable resolves when the ghost is canceled
--      D6 late_pickup_left_unsold: flagged with 0356's restore trigger off;
--         with it on the same sequence produces no row
--      D7 no_show_sweep_stalled: resolves on a succeeded run, reopens without
--      D8 legitimate flows produce NO rows: return then relist; put back then
--         relist; the guarded sweep
--      D9 the event window: an old flip is outside 7 days, inside 60
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code, pickup_grace_extension_hours)
VALUES ('c0120000-0000-0000-0000-000000000001', 'invmon', 'Invariant Monitor Co', 'im@example.com', 'IVM', 0);

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('c0120000-0000-0000-0000-000000000002', 'c0120000-0000-0000-0000-000000000001',
        'IVM WH', '1 Monitor St', 'Harrison', 'AR', '72601');

INSERT INTO bins (id, warehouse_id, code, aisle, x_px, y_px)
VALUES ('c0120000-0000-0000-0000-000000000006', 'c0120000-0000-0000-0000-000000000002', 'IVM-1-01-01', '1', 0, 0);

INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('c0120000-0000-0000-0000-000000000003', 'c0120000-0000-0000-0000-000000000001',
        'c0120000-0000-0000-0000-000000000002', 'IVM target', 'draft',
        now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('c0120000-0000-0000-0000-000000000005', 'ivm-bidder@example.com');
INSERT INTO bidders (id, email, birth_date)
VALUES ('c0120000-0000-0000-0000-000000000005', 'ivm-bidder@example.com', DATE '1990-01-01');

-- Helpers -------------------------------------------------------------------

CREATE FUNCTION pg_temp.mk_invoice(p_status invoice_status DEFAULT 'paid')
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v UUID; a UUID;
BEGIN
  INSERT INTO auctions (operator_id, warehouse_id, title, status,
                        starts_at, ends_at, pickup_starts_at, pickup_ends_at)
  VALUES ('c0120000-0000-0000-0000-000000000001', 'c0120000-0000-0000-0000-000000000002',
          'IVM closed ' || gen_random_uuid()::text, 'closed',
          now() - interval '10 days', now() - interval '8 days',
          now() - interval '7 days', now() - interval '2 days')
  RETURNING id INTO a;
  INSERT INTO invoices (operator_id, auction_id, bidder_id, status, paid_at)
  VALUES ('c0120000-0000-0000-0000-000000000001', a, 'c0120000-0000-0000-0000-000000000005', p_status,
          CASE WHEN p_status = 'paid' THEN now() - interval '5 days' END)
  RETURNING id INTO v;
  RETURN v;
END $$;

CREATE FUNCTION pg_temp.mk_lot(p_code TEXT, p_status lot_status, p_parent UUID DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v UUID;
BEGIN
  INSERT INTO lots (operator_id, warehouse_id, lot_code, title, status, relisted_from_lot_id, relist_count)
  VALUES ('c0120000-0000-0000-0000-000000000001', 'c0120000-0000-0000-0000-000000000002',
          p_code, 'invariant-monitor fixture', p_status, p_parent, CASE WHEN p_parent IS NULL THEN 0 ELSE 1 END)
  RETURNING id INTO v;
  RETURN v;
END $$;

-- A line on a fresh invoice, optionally stamped/refunded, with a pickup row.
CREATE FUNCTION pg_temp.mk_line(p_lot UUID, p_picked_up TIMESTAMPTZ DEFAULT NULL, p_refunded TIMESTAMPTZ DEFAULT NULL,
                                p_invoice_status invoice_status DEFAULT 'paid', p_pickup_status pickup_status DEFAULT 'completed')
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_inv UUID;
BEGIN
  v_inv := pg_temp.mk_invoice(p_invoice_status);
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at, refunded_at)
  VALUES (v_inv, p_lot, 1000, p_picked_up, p_refunded);
  INSERT INTO pickups (invoice_id, warehouse_id, status)
  VALUES (v_inv, 'c0120000-0000-0000-0000-000000000002', p_pickup_status);
  RETURN v_inv;
END $$;

-- Status change attempt: 'OK', or the error code (text before the first colon).
CREATE FUNCTION pg_temp.try_status(p_lot UUID, p_status lot_status) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  UPDATE lots SET status = p_status WHERE id = p_lot;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN split_part(SQLERRM, ':', 1);
END $$;

-- Reclaim attempt through the 0358 guard: CHANGED (applied), REFUSED (row
-- skipped AND recorded in invariant_violations), SKIPPED_UNRECORDED (skipped
-- but nobody told), or an error code if something raised.
CREATE FUNCTION pg_temp.reclaim(p_lot UUID, p_status lot_status) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_after TEXT;
BEGIN
  UPDATE lots SET status = p_status WHERE id = p_lot;
  SELECT status::text INTO v_after FROM lots WHERE id = p_lot;
  IF v_after = p_status::text THEN RETURN 'CHANGED'; END IF;
  IF EXISTS (SELECT 1 FROM invariant_violations v
              WHERE v.check_code = 'collected_lot_reclaim_refused' AND v.lot_id = p_lot AND v.resolved_at IS NULL) THEN
    RETURN 'REFUSED';
  END IF;
  RETURN 'SKIPPED_UNRECORDED';
EXCEPTION WHEN OTHERS THEN
  RETURN split_part(SQLERRM, ':', 1);
END $$;

CREATE FUNCTION pg_temp.try_relist(p_lot UUID) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v UUID;
BEGIN
  v := relist_lot_into_auction(p_lot, 'c0120000-0000-0000-0000-000000000003');
  RETURN CASE WHEN v IS NULL THEN 'NULL' ELSE 'ALLOWED' END;
EXCEPTION WHEN OTHERS THEN
  RETURN split_part(SQLERRM, ':', 1);
END $$;

CREATE FUNCTION pg_temp.lot_status(p_lot UUID) RETURNS TEXT LANGUAGE sql AS $$
  SELECT status::text FROM lots WHERE id = p_lot $$;

-- A put-away scan of the box, later than anything else in this transaction
-- (now() is frozen for the transaction, and a lot's own birth event is ignored
-- by the guards; a real scan is always later than the row it is scanned against).
CREATE FUNCTION pg_temp.scan(p_lot UUID) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO lot_location_events (lot_id, bin_id, kind, occurred_at)
  VALUES (p_lot, 'c0120000-0000-0000-0000-000000000006', 'intake', now() + interval '1 minute') $$;

CREATE FUNCTION pg_temp.run_check(p_window INTERVAL DEFAULT interval '7 days') RETURNS JSONB LANGUAGE sql AS $$
  SELECT public.check_collected_item_invariants(p_window) $$;

-- Row state for (check, lot): none | open | notified | acknowledged | resolved
CREATE FUNCTION pg_temp.v_state(p_check TEXT, p_lot UUID) RETURNS TEXT LANGUAGE sql AS $$
  SELECT COALESCE((
    SELECT CASE WHEN v.resolved_at IS NOT NULL THEN 'resolved'
                WHEN v.acknowledged_at IS NOT NULL THEN 'acknowledged'
                WHEN v.notified_at IS NOT NULL THEN 'notified'
                ELSE 'open' END
      FROM invariant_violations v
     WHERE v.check_code = p_check AND v.lot_id IS NOT DISTINCT FROM p_lot), 'none') $$;

CREATE FUNCTION pg_temp.v_sev(p_check TEXT, p_lot UUID) RETURNS TEXT LANGUAGE sql AS $$
  SELECT COALESCE((SELECT v.severity FROM invariant_violations v
                    WHERE v.check_code = p_check AND v.lot_id IS NOT DISTINCT FROM p_lot), 'none') $$;

CREATE FUNCTION pg_temp.v_detail(p_check TEXT, p_lot UUID, p_key TEXT) RETURNS TEXT LANGUAGE sql AS $$
  SELECT v.details->>p_key FROM invariant_violations v
   WHERE v.check_code = p_check AND v.lot_id IS NOT DISTINCT FROM p_lot $$;

-- Toggle a guard trigger, tolerating its absence: running this file against a
-- database without 0358 must reach the verdict and list the failed
-- assertions, not die on ALTER TABLE.
CREATE FUNCTION pg_temp.set_trigger(p_table TEXT, p_trigger TEXT, p_on BOOLEAN) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_deferred TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              WHERE c.relname = p_table AND t.tgname = p_trigger) THEN
    -- ALTER TABLE refuses while deferred constraint-trigger events are queued
    -- (0475's invoice_lots trigger). Fire them now, as a commit would, then
    -- put those constraints back to deferred.
    SELECT string_agg(quote_ident(t.tgname), ', ') INTO v_deferred
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = p_table AND t.tgdeferrable AND t.tginitdeferred;
    IF v_deferred IS NOT NULL THEN EXECUTE 'SET CONSTRAINTS ' || v_deferred || ' IMMEDIATE'; END IF;
    EXECUTE format('ALTER TABLE %I %s TRIGGER %I', p_table, CASE WHEN p_on THEN 'ENABLE' ELSE 'DISABLE' END, p_trigger);
    IF v_deferred IS NOT NULL THEN EXECUTE 'SET CONSTRAINTS ' || v_deferred || ' DEFERRED'; END IF;
  END IF;
END $$;

-- Failure accumulator.
CREATE TEMP TABLE _fail (msg TEXT);
CREATE FUNCTION pg_temp.expect(p_label TEXT, p_got TEXT, p_want TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    INSERT INTO _fail VALUES (format('%s -> got %s, expected %s', p_label, coalesce(p_got,'NULL'), p_want));
  END IF;
END $$;

-- D0 (first, before anything here writes a row): the 0357 seed acknowledged
-- whatever it found on install; nothing is waiting for an email.
DO $$
BEGIN
  PERFORM pg_temp.expect('D0 nothing unacknowledged at start',
    (SELECT count(*) FROM invariant_violations WHERE resolved_at IS NULL AND acknowledged_at IS NULL)::text, '0');
  PERFORM pg_temp.expect('D0 seed left a heartbeat', (SELECT count(*) >= 1 FROM invariant_check_runs)::text, 'true');
END $$;

-- ---------------------------------------------------------------------------
-- G: the 0358 reclaim guard — skips the row, records the attempt, never aborts
-- ---------------------------------------------------------------------------
DO $$
DECLARE l UUID; c UUID; inv UUID; r JSONB;
BEGIN
  -- G1 collected, unrefunded, never put back -> the write is skipped and recorded
  l := pg_temp.mk_lot('IVM-G1', 'won'); inv := pg_temp.mk_line(l, now() - interval '1 day');
  PERFORM pg_temp.expect('G1 won->unsold refused',       pg_temp.reclaim(l, 'unsold'),       'REFUSED');
  PERFORM pg_temp.expect('G1 won->in_inventory refused', pg_temp.reclaim(l, 'in_inventory'), 'REFUSED');
  PERFORM pg_temp.expect('G1 still won',                 pg_temp.lot_status(l), 'won');
  PERFORM pg_temp.expect('G1 one row, two refusals',     pg_temp.v_detail('collected_lot_reclaim_refused', l, 'refusals'), '2');
  PERFORM pg_temp.expect('G1 records the attempted status', pg_temp.v_detail('collected_lot_reclaim_refused', l, 'attempted_status'), 'in_inventory');
  PERFORM pg_temp.expect('G1 severity page',             pg_temp.v_sev('collected_lot_reclaim_refused', l), 'page');
  PERFORM pg_temp.expect('G1 not yet notified',          pg_temp.v_state('collected_lot_reclaim_refused', l), 'open');
  -- remedy: the line is refunded -> the monitor resolves the record
  UPDATE invoice_lots SET refunded_at = now() WHERE invoice_id = inv;
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('G1 resolved once the line is refunded', pg_temp.v_state('collected_lot_reclaim_refused', l), 'resolved');
  PERFORM pg_temp.expect('G1 reclaim allowed after refund',       pg_temp.reclaim(l, 'unsold'), 'CHANGED');

  -- G2 the line was refunded: a return, stock again
  l := pg_temp.mk_lot('IVM-G2', 'won'); inv := pg_temp.mk_line(l, now() - interval '1 day', now() - interval '1 hour');
  PERFORM pg_temp.expect('G2 refunded line allowed', pg_temp.reclaim(l, 'unsold'), 'CHANGED');

  -- G3 the whole invoice was refunded (lines are not stamped by that path)
  l := pg_temp.mk_lot('IVM-G3', 'won'); inv := pg_temp.mk_line(l, now() - interval '1 day', NULL, 'refunded');
  PERFORM pg_temp.expect('G3 refunded invoice allowed', pg_temp.reclaim(l, 'unsold'), 'CHANGED');

  -- G4 a location event at the lot's own birth does not clear; a later scan does
  l := pg_temp.mk_lot('IVM-G4', 'won'); inv := pg_temp.mk_line(l, now() - interval '1 day');
  INSERT INTO lot_location_events (lot_id, bin_id, kind, occurred_at)
  VALUES (l, 'c0120000-0000-0000-0000-000000000006', 'intake', now());
  PERFORM pg_temp.expect('G4a birth-time event does not clear', pg_temp.reclaim(l, 'unsold'), 'REFUSED');
  PERFORM pg_temp.scan(l);
  PERFORM pg_temp.expect('G4b later put-away scan clears', pg_temp.reclaim(l, 'unsold'), 'CHANGED');
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('G4c refusal record resolves after the scan', pg_temp.v_state('collected_lot_reclaim_refused', l), 'resolved');

  -- G5 never collected
  l := pg_temp.mk_lot('IVM-G5', 'won'); inv := pg_temp.mk_line(l, NULL, NULL, 'paid', 'pending');
  PERFORM pg_temp.expect('G5 never collected allowed', pg_temp.reclaim(l, 'unsold'), 'CHANGED');

  -- G6 already stock: unsold -> in_inventory is the worklist pull, not a reclaim
  l := pg_temp.mk_lot('IVM-G6', 'unsold'); inv := pg_temp.mk_line(l, now() - interval '1 day');
  PERFORM pg_temp.expect('G6 unsold->in_inventory allowed', pg_temp.reclaim(l, 'in_inventory'), 'CHANGED');

  -- G7 not stock: a collected lot may still be canceled / relisted / disposed
  l := pg_temp.mk_lot('IVM-G7', 'won'); inv := pg_temp.mk_line(l, now() - interval '1 day');
  PERFORM pg_temp.expect('G7 won->canceled allowed', pg_temp.reclaim(l, 'canceled'), 'CHANGED');

  -- G8 the box was scanned at Put-away under a relist CHILD's code
  l := pg_temp.mk_lot('IVM-G8', 'won'); inv := pg_temp.mk_line(l, now() - interval '1 day');
  PERFORM pg_temp.set_trigger('lots', 'lots_block_relist_of_collected_item_trg', false);   -- 0356 would refuse the child
  c := pg_temp.mk_lot('IVM-G8c', 'unsold', l);
  PERFORM pg_temp.set_trigger('lots', 'lots_block_relist_of_collected_item_trg', true);
  PERFORM pg_temp.expect('G8a parent blocked before scan', pg_temp.reclaim(l, 'unsold'), 'REFUSED');
  PERFORM pg_temp.scan(c);
  PERFORM pg_temp.expect('G8b scan on child clears parent', pg_temp.reclaim(l, 'unsold'), 'CHANGED');

  -- G9 a statement touching a collected lot AND an ordinary lot applies to the
  --    ordinary one: skipping is per row, not per statement
  l := pg_temp.mk_lot('IVM-G9a', 'won'); inv := pg_temp.mk_line(l, now() - interval '1 day');
  c := pg_temp.mk_lot('IVM-G9b', 'won'); PERFORM pg_temp.mk_line(c, NULL, NULL, 'paid', 'pending');
  UPDATE lots SET status = 'unsold' WHERE id IN (l, c);
  PERFORM pg_temp.expect('G9 collected lot kept won',   pg_temp.lot_status(l), 'won');
  PERFORM pg_temp.expect('G9 ordinary lot reclaimed',   pg_temp.lot_status(c), 'unsold');
  PERFORM pg_temp.expect('G9 refusal recorded',         pg_temp.v_state('collected_lot_reclaim_refused', l), 'open');
END $$;

-- ---------------------------------------------------------------------------
-- S: the no-show sweep — guarded it succeeds; unguarded the tick rolls back
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  inv UUID; pk UUID; took UUID; stayed UUID;
  inv2 UUID; pk2 UUID; took2 UUID; stayed2 UUID;
  r JSONB; v_src TEXT; v_patched TEXT; v_err TEXT;
BEGIN
  -- S1: partial pickup past its window, one item stamped. The 0351 guard
  -- leaves the stamped lot alone, so the 0358 trigger is never reached.
  inv := pg_temp.mk_invoice('paid');
  took := pg_temp.mk_lot('IVM-S1-took', 'won');
  stayed := pg_temp.mk_lot('IVM-S1-left', 'won');
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at) VALUES
    (inv, took, 1000, now() - interval '3 days'),
    (inv, stayed, 1000, NULL);
  INSERT INTO pickups (invoice_id, warehouse_id, status, checked_in_at)
  VALUES (inv, 'c0120000-0000-0000-0000-000000000002', 'checked_in', now() - interval '3 days') RETURNING id INTO pk;

  r := auto_mark_pickup_no_show();
  PERFORM pg_temp.expect('S1 guarded sweep completes', ((SELECT status::text FROM pickups WHERE id = pk) IN ('no_show','forfeited'))::text, 'true');
  PERFORM pg_temp.expect('S1 stamped item stays won',   pg_temp.lot_status(took), 'won');
  PERFORM pg_temp.expect('S1 uncollected item unsold',  pg_temp.lot_status(stayed), 'unsold');

  -- S2: the pre-09-10 sweep. Patch the 0351 guard OUT of the live definition
  -- (the exact text 0351 spliced in), so Step 2 tries to reclaim the stamped
  -- lot. The 0358 trigger skips that one row and records it; everything else
  -- in the tick — the pickup flip, the other lot, the audit row — completes.
  -- (Raising instead would abort the whole pg_cron tick every 30 minutes: a
  -- silent outage in place of a silent data bug.)
  v_src := pg_get_functiondef('public.auto_mark_pickup_no_show()'::regprocedure);
  v_patched := regexp_replace(v_src,
    'WHERE il\.picked_up_at IS NULL\s+AND il\.refunded_at\s+IS NULL\s+AND NOT EXISTS \(SELECT 1 FROM pickup_sessions ps\s+WHERE ps\.collected_lot_ids @> ARRAY\[il\.lot_id\]\)',
    '');
  IF v_patched = v_src THEN
    RAISE EXCEPTION 'S2: could not find the 0351 guard in auto_mark_pickup_no_show() to patch out';
  END IF;
  EXECUTE v_patched;

  inv2 := pg_temp.mk_invoice('paid');
  took2 := pg_temp.mk_lot('IVM-S2-took', 'won');
  stayed2 := pg_temp.mk_lot('IVM-S2-left', 'won');
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at) VALUES
    (inv2, took2, 1000, now() - interval '3 days'),
    (inv2, stayed2, 1000, NULL);
  INSERT INTO pickups (invoice_id, warehouse_id, status, checked_in_at)
  VALUES (inv2, 'c0120000-0000-0000-0000-000000000002', 'checked_in', now() - interval '3 days') RETURNING id INTO pk2;

  BEGIN
    r := auto_mark_pickup_no_show();
    v_err := 'no error';
  EXCEPTION WHEN OTHERS THEN
    v_err := split_part(SQLERRM, ':', 1);
  END;
  PERFORM pg_temp.expect('S2 unguarded sweep completes (no abort)',       v_err, 'no error');
  PERFORM pg_temp.expect('S2 pickup swept (Step 1 intact)',               ((SELECT status::text FROM pickups WHERE id = pk2) IN ('no_show','forfeited'))::text, 'true');
  PERFORM pg_temp.expect('S2 stamped lot kept won (row skipped)',         pg_temp.lot_status(took2), 'won');
  PERFORM pg_temp.expect('S2 uncollected lot reclaimed (Step 2 intact)',  pg_temp.lot_status(stayed2), 'unsold');
  PERFORM pg_temp.expect('S2 uncollected line forfeited',                 (SELECT forfeited_at IS NOT NULL FROM invoice_lots WHERE invoice_id = inv2 AND lot_id = stayed2)::text, 'true');
  PERFORM pg_temp.expect('S2 stamped line NOT forfeited',                 (SELECT forfeited_at IS NULL FROM invoice_lots WHERE invoice_id = inv2 AND lot_id = took2)::text, 'true');
  PERFORM pg_temp.expect('S2 audit row written (Step 3b intact)',         ((SELECT count(*) FROM operator_audit_log WHERE target_id = inv2) >= 1)::text, 'true');
  PERFORM pg_temp.expect('S2 refusal recorded for the stamped lot',       pg_temp.v_state('collected_lot_reclaim_refused', took2), 'open');
  PERFORM pg_temp.expect('S2 refusal severity page',                      pg_temp.v_sev('collected_lot_reclaim_refused', took2), 'page');
  PERFORM pg_temp.expect('S2 refusal captured the writer''s query',        (length(pg_temp.v_detail('collected_lot_reclaim_refused', took2, 'writer')) > 0)::text, 'true');

  EXECUTE v_src;   -- restore the real sweep for the rest of the file
END $$;

-- ---------------------------------------------------------------------------
-- D: the monitor
-- ---------------------------------------------------------------------------

-- D1 collected_lot_reclaimed
DO $$
DECLARE l UUID; l2 UUID; inv UUID; inv2 UUID; r JSONB;
BEGIN
  l := pg_temp.mk_lot('IVM-D1', 'won'); inv := pg_temp.mk_line(l, now() - interval '1 day');
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D1 clean before the reclaim', pg_temp.v_state('collected_lot_reclaimed', l), 'none');

  -- BREAK: bypass 0358 (a dropped trigger / a bypassing backfill) and reclaim
  PERFORM pg_temp.set_trigger('lots', 'lots_collected_item_cannot_be_reclaimed_trg', false);
  UPDATE lots SET status = 'unsold' WHERE id = l;
  PERFORM pg_temp.set_trigger('lots', 'lots_collected_item_cannot_be_reclaimed_trg', true);

  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D1 flagged',            pg_temp.v_state('collected_lot_reclaimed', l), 'open');
  PERFORM pg_temp.expect('D1 severity page',      pg_temp.v_sev('collected_lot_reclaimed', l), 'page');
  PERFORM pg_temp.expect('D1 details.to_status',  pg_temp.v_detail('collected_lot_reclaimed', l, 'to_status'), 'unsold');
  PERFORM pg_temp.expect('D1 counted as new',     ((r->>'new')::int >= 1)::text, 'true');
  PERFORM pg_temp.expect('D1 open_page counts it', ((r->>'open_page')::int >= 1)::text, 'true');

  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D1 rerun adds nothing (dedupe)', r->>'new', '0');
  PERFORM pg_temp.expect('D1 rerun keeps it open',         pg_temp.v_state('collected_lot_reclaimed', l), 'open');
  PERFORM pg_temp.expect('D1 exactly one row for the lot',
    (SELECT count(*) FROM invariant_violations WHERE lot_id = l AND check_code = 'collected_lot_reclaimed')::text, '1');

  -- REMEDY A: the owner sets it back to won (as happened for 128 lots)
  UPDATE lots SET status = 'won' WHERE id = l;
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D1 resolved when restored to won', pg_temp.v_state('collected_lot_reclaimed', l), 'resolved');

  -- RECURRENCE after it was emailed and acknowledged: reopened and news again
  UPDATE invariant_violations SET notified_at = now(), acknowledged_at = now()
   WHERE lot_id = l AND check_code = 'collected_lot_reclaimed';
  PERFORM pg_temp.set_trigger('lots', 'lots_collected_item_cannot_be_reclaimed_trg', false);
  UPDATE lots SET status = 'in_inventory' WHERE id = l;
  PERFORM pg_temp.set_trigger('lots', 'lots_collected_item_cannot_be_reclaimed_trg', true);
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D1 recurrence reopens as unnotified', pg_temp.v_state('collected_lot_reclaimed', l), 'open');
  PERFORM pg_temp.expect('D1 recurrence details refreshed',    pg_temp.v_detail('collected_lot_reclaimed', l, 'to_status'), 'in_inventory');

  -- REMEDY B: the line is refunded (the customer kept it, we reclaim the money side)
  UPDATE invoice_lots SET refunded_at = now() WHERE invoice_id = inv;
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D1 resolved when line refunded', pg_temp.v_state('collected_lot_reclaimed', l), 'resolved');

  -- REMEDY C on a second lot: the box turns up and is scanned at Put-away
  l2 := pg_temp.mk_lot('IVM-D1b', 'won'); inv2 := pg_temp.mk_line(l2, now() - interval '1 day');
  PERFORM pg_temp.set_trigger('lots', 'lots_collected_item_cannot_be_reclaimed_trg', false);
  UPDATE lots SET status = 'unsold' WHERE id = l2;
  PERFORM pg_temp.set_trigger('lots', 'lots_collected_item_cannot_be_reclaimed_trg', true);
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D1b flagged', pg_temp.v_state('collected_lot_reclaimed', l2), 'open');
  PERFORM pg_temp.scan(l2);
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D1b resolved when put back', pg_temp.v_state('collected_lot_reclaimed', l2), 'resolved');
END $$;

-- D2 collected_lineage_relisted + ghost_child_relistable
DO $$
DECLARE root UUID; child UUID; grand UUID; inv UUID; r JSONB;
BEGIN
  root := pg_temp.mk_lot('IVM-D2', 'won'); inv := pg_temp.mk_line(root, now() - interval '2 days');

  -- BREAK: bypass 0356 and relist the collected item, then relist the relist
  PERFORM pg_temp.set_trigger('lots', 'lots_block_relist_of_collected_item_trg', false);
  child := pg_temp.mk_lot('IVM-D2c', 'scheduled', root);
  grand := pg_temp.mk_lot('IVM-D2g', 'unsold', child);
  PERFORM pg_temp.set_trigger('lots', 'lots_block_relist_of_collected_item_trg', true);

  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D2 child flagged',             pg_temp.v_state('collected_lineage_relisted', child), 'open');
  PERFORM pg_temp.expect('D2 child severity page',       pg_temp.v_sev('collected_lineage_relisted', child), 'page');
  PERFORM pg_temp.expect('D2 grandchild flagged',        pg_temp.v_state('collected_lineage_relisted', grand), 'open');
  PERFORM pg_temp.expect('D2 grandchild generations=2',  pg_temp.v_detail('collected_lineage_relisted', grand, 'generations'), '2');
  PERFORM pg_temp.expect('D2 root named',                pg_temp.v_detail('collected_lineage_relisted', grand, 'root_lot'), 'IVM-D2');
  PERFORM pg_temp.expect('D2 unsold grandchild is a ghost', pg_temp.v_state('ghost_child_relistable', grand), 'open');
  PERFORM pg_temp.expect('D2 ghost severity watch',      pg_temp.v_sev('ghost_child_relistable', grand), 'watch');
  PERFORM pg_temp.expect('D2 scheduled child is not a ghost', pg_temp.v_state('ghost_child_relistable', child), 'none');
  PERFORM pg_temp.expect('D2 root itself not flagged as reclaimed', pg_temp.v_state('collected_lot_reclaimed', root), 'none');

  -- REMEDY: the box turns up; Put-away scan under the child's code clears the lineage
  PERFORM pg_temp.scan(child);
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D2 child resolved on scan',      pg_temp.v_state('collected_lineage_relisted', child), 'resolved');
  PERFORM pg_temp.expect('D2 grandchild resolved on scan', pg_temp.v_state('collected_lineage_relisted', grand), 'resolved');
  PERFORM pg_temp.expect('D2 ghost resolved on scan',      pg_temp.v_state('ghost_child_relistable', grand), 'resolved');
END $$;

-- D3 collected_lineage_ticked_relisted (customer tick only -> watch)
DO $$
DECLARE root UUID; child UUID; inv UUID; r JSONB;
BEGIN
  root := pg_temp.mk_lot('IVM-D3', 'won'); inv := pg_temp.mk_line(root, NULL, NULL, 'paid', 'pending');
  INSERT INTO pickup_sessions (bidder_id, collected_lot_ids, created_at, status)
  VALUES ('c0120000-0000-0000-0000-000000000005', ARRAY[root], now() - interval '2 days', 'completed');

  PERFORM pg_temp.set_trigger('lots', 'lots_block_relist_of_collected_item_trg', false);
  child := pg_temp.mk_lot('IVM-D3c', 'scheduled', root);
  PERFORM pg_temp.set_trigger('lots', 'lots_block_relist_of_collected_item_trg', true);

  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D3 ticked relist flagged',     pg_temp.v_state('collected_lineage_ticked_relisted', child), 'open');
  PERFORM pg_temp.expect('D3 severity watch',            pg_temp.v_sev('collected_lineage_ticked_relisted', child), 'watch');
  PERFORM pg_temp.expect('D3 not reported as stamped',   pg_temp.v_state('collected_lineage_relisted', child), 'none');

  UPDATE invoice_lots SET refunded_at = now() WHERE invoice_id = inv;
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D3 resolved when line refunded', pg_temp.v_state('collected_lineage_ticked_relisted', child), 'resolved');
END $$;

-- D4 second_buyer_promise (+ ticked variant)
DO $$
DECLARE root UUID; child UUID; child2 UUID; root3 UUID; child3 UUID; inv UUID; inv2 UUID; inv2b UUID; inv3 UUID; r JSONB;
BEGIN
  root := pg_temp.mk_lot('IVM-D4', 'won'); inv := pg_temp.mk_line(root, now() - interval '3 days');
  PERFORM pg_temp.set_trigger('lots', 'lots_block_relist_of_collected_item_trg', false);
  child  := pg_temp.mk_lot('IVM-D4c',  'won', root);
  child2 := pg_temp.mk_lot('IVM-D4c2', 'won', root);
  PERFORM pg_temp.set_trigger('lots', 'lots_block_relist_of_collected_item_trg', true);
  inv2  := pg_temp.mk_line(child,  NULL, NULL, 'paid', 'pending');   -- second buyer paid, waiting to collect
  inv2b := pg_temp.mk_line(child2, NULL, NULL, 'paid', 'pending');

  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D4 promise flagged',           pg_temp.v_state('second_buyer_promise', child), 'open');
  PERFORM pg_temp.expect('D4 severity page',             pg_temp.v_sev('second_buyer_promise', child), 'page');
  PERFORM pg_temp.expect('D4 names the second invoice',  pg_temp.v_detail('second_buyer_promise', child, 'second_invoice_id'), inv2::text);
  PERFORM pg_temp.expect('D4 names the first lot',       pg_temp.v_detail('second_buyer_promise', child, 'root_lot'), 'IVM-D4');
  PERFORM pg_temp.expect('D4b second promise flagged',   pg_temp.v_state('second_buyer_promise', child2), 'open');

  -- REMEDY A: refund the second buyer
  UPDATE invoice_lots SET refunded_at = now() WHERE invoice_id = inv2;
  -- REMEDY B: the second buyer's line is forfeited instead
  UPDATE invoice_lots SET forfeited_at = now() WHERE invoice_id = inv2b;
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D4 resolved when refunded',   pg_temp.v_state('second_buyer_promise', child),  'resolved');
  PERFORM pg_temp.expect('D4b resolved when forfeited', pg_temp.v_state('second_buyer_promise', child2), 'resolved');

  -- ticked variant -> watch
  root3 := pg_temp.mk_lot('IVM-D4t', 'won'); inv3 := pg_temp.mk_line(root3, NULL, NULL, 'paid', 'pending');
  INSERT INTO pickup_sessions (bidder_id, collected_lot_ids, created_at, status)
  VALUES ('c0120000-0000-0000-0000-000000000005', ARRAY[root3], now() - interval '2 days', 'completed')
  ON CONFLICT DO NOTHING;
  -- one open session per bidder: fold the tick into whichever session exists
  UPDATE pickup_sessions SET collected_lot_ids = array_append(collected_lot_ids, root3)
   WHERE bidder_id = 'c0120000-0000-0000-0000-000000000005' AND NOT (collected_lot_ids @> ARRAY[root3]);
  PERFORM pg_temp.set_trigger('lots', 'lots_block_relist_of_collected_item_trg', false);
  child3 := pg_temp.mk_lot('IVM-D4tc', 'won', root3);
  PERFORM pg_temp.set_trigger('lots', 'lots_block_relist_of_collected_item_trg', true);
  PERFORM pg_temp.mk_line(child3, NULL, NULL, 'paid', 'pending');
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D4t ticked promise flagged', pg_temp.v_state('second_buyer_promise_ticked', child3), 'open');
  PERFORM pg_temp.expect('D4t severity watch',         pg_temp.v_sev('second_buyer_promise_ticked', child3), 'watch');
  PERFORM pg_temp.expect('D4t not reported as page',   pg_temp.v_state('second_buyer_promise', child3), 'none');
END $$;

-- D5 ghost_child_relistable resolves when the ghost is canceled
DO $$
DECLARE root UUID; child UUID; inv UUID; r JSONB;
BEGIN
  root := pg_temp.mk_lot('IVM-D5', 'won'); inv := pg_temp.mk_line(root, now() - interval '2 days');
  PERFORM pg_temp.set_trigger('lots', 'lots_block_relist_of_collected_item_trg', false);
  child := pg_temp.mk_lot('IVM-D5c', 'in_inventory', root);
  PERFORM pg_temp.set_trigger('lots', 'lots_block_relist_of_collected_item_trg', true);
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D5 ghost flagged',       pg_temp.v_state('ghost_child_relistable', child), 'open');
  PERFORM pg_temp.expect('D5 0356 still refuses the relist', (pg_temp.try_relist(child) <> 'ALLOWED')::text, 'true');
  UPDATE lots SET status = 'canceled' WHERE id = child;
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D5 resolved when canceled', pg_temp.v_state('ghost_child_relistable', child), 'resolved');
END $$;

-- D6 late_pickup_left_unsold
DO $$
DECLARE l UUID; l2 UUID; inv UUID; inv2 UUID; r JSONB;
BEGIN
  -- BREAK: with 0356's restore trigger off, a late collection leaves the lot unsold
  l := pg_temp.mk_lot('IVM-D6', 'unsold'); inv := pg_temp.mk_line(l, NULL, NULL, 'paid', 'forfeited');
  UPDATE invoice_lots SET forfeited_at = now() - interval '1 day' WHERE invoice_id = inv;
  PERFORM pg_temp.set_trigger('invoice_lots', 'invoice_lots_late_pickup_restores_won_trg', false);
  UPDATE invoice_lots SET picked_up_at = now() WHERE invoice_id = inv;
  PERFORM pg_temp.set_trigger('invoice_lots', 'invoice_lots_late_pickup_restores_won_trg', true);
  PERFORM pg_temp.expect('D6 lot left unsold (trigger off)', pg_temp.lot_status(l), 'unsold');
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D6 flagged',        pg_temp.v_state('late_pickup_left_unsold', l), 'open');
  PERFORM pg_temp.expect('D6 severity watch', pg_temp.v_sev('late_pickup_left_unsold', l), 'watch');
  UPDATE lots SET status = 'won' WHERE id = l;
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D6 resolved when restored', pg_temp.v_state('late_pickup_left_unsold', l), 'resolved');

  -- CONTROL: with the trigger on, the same sequence restores 'won' and produces no row
  l2 := pg_temp.mk_lot('IVM-D6b', 'unsold'); inv2 := pg_temp.mk_line(l2, NULL, NULL, 'paid', 'forfeited');
  UPDATE invoice_lots SET forfeited_at = now() - interval '1 day' WHERE invoice_id = inv2;
  UPDATE invoice_lots SET picked_up_at = now() WHERE invoice_id = inv2;
  PERFORM pg_temp.expect('D6b 0356 restored won', pg_temp.lot_status(l2), 'won');
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D6b no row', pg_temp.v_state('late_pickup_left_unsold', l2), 'none');
END $$;

-- D7 no_show_sweep_stalled
DO $$
DECLARE r JSONB; v_job BIGINT;
BEGIN
  SELECT jobid INTO v_job FROM cron.job WHERE jobname = 'auto-mark-pickup-no-show';
  PERFORM pg_temp.expect('D7 sweep is registered', (v_job IS NOT NULL)::text, 'true');
  -- CI has no run history, so the seed found it stalled and acknowledged it
  PERFORM pg_temp.expect('D7 stalled at start (no run history)',
    (pg_temp.v_state('no_show_sweep_stalled', NULL) IN ('acknowledged', 'open'))::text, 'true');

  INSERT INTO cron.job_run_details (jobid, status, start_time, end_time)
  VALUES (v_job, 'succeeded', now() - interval '10 minutes', now() - interval '10 minutes');
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D7 resolved after a succeeded run', pg_temp.v_state('no_show_sweep_stalled', NULL), 'resolved');

  UPDATE cron.job_run_details SET start_time = now() - interval '2 hours' WHERE jobid = v_job;
  r := pg_temp.run_check();
  PERFORM pg_temp.expect('D7 reopened when the last success ages past 90 min', pg_temp.v_state('no_show_sweep_stalled', NULL), 'open');
  PERFORM pg_temp.expect('D7 severity page', pg_temp.v_sev('no_show_sweep_stalled', NULL), 'page');
END $$;

-- D8 legitimate flows produce no rows
DO $$
DECLARE l UUID; c UUID; inv UUID; r JSONB; before INT; after INT;
BEGIN
  SELECT count(*) INTO before FROM invariant_violations WHERE resolved_at IS NULL;

  -- a return: collected, refunded at the counter, relisted through the real RPC
  l := pg_temp.mk_lot('IVM-D8a', 'won'); inv := pg_temp.mk_line(l, now() - interval '2 days', now() - interval '1 day');
  PERFORM pg_temp.expect('D8a relist of a returned item allowed', pg_temp.try_relist(l), 'ALLOWED');
  SELECT id INTO c FROM lots WHERE relisted_from_lot_id = l;
  PERFORM pg_temp.mk_line(c, NULL, NULL, 'paid', 'pending');   -- and sold again, legitimately

  -- put back: collected, scanned onto a shelf, returned to stock, relisted
  l := pg_temp.mk_lot('IVM-D8b', 'won'); inv := pg_temp.mk_line(l, now() - interval '2 days');
  PERFORM pg_temp.scan(l);
  PERFORM pg_temp.expect('D8b put-back item may return to stock', pg_temp.try_status(l, 'unsold'), 'OK');
  PERFORM pg_temp.expect('D8b relist of a put-back item allowed', pg_temp.try_relist(l), 'ALLOWED');

  r := pg_temp.run_check();
  SELECT count(*) INTO after FROM invariant_violations WHERE resolved_at IS NULL;
  PERFORM pg_temp.expect('D8 legit flows add no open rows', (after - before)::text, '0');
  PERFORM pg_temp.expect('D8 run reports nothing new', r->>'new', '0');
END $$;

-- D9 the event window
DO $$
DECLARE l UUID; inv UUID; r JSONB;
BEGIN
  l := pg_temp.mk_lot('IVM-D9', 'won'); inv := pg_temp.mk_line(l, now() - interval '20 days');
  PERFORM pg_temp.set_trigger('lots', 'lots_collected_item_cannot_be_reclaimed_trg', false);
  UPDATE lots SET status = 'unsold' WHERE id = l;
  PERFORM pg_temp.set_trigger('lots', 'lots_collected_item_cannot_be_reclaimed_trg', true);
  -- pretend the flip happened 10 days ago
  UPDATE lot_status_history SET changed_at = now() - interval '10 days' WHERE lot_id = l AND to_status = 'unsold';

  r := pg_temp.run_check(interval '7 days');
  PERFORM pg_temp.expect('D9 outside a 7-day window: not an event',  pg_temp.v_state('collected_lot_reclaimed', l), 'none');
  r := pg_temp.run_check(interval '60 days');
  PERFORM pg_temp.expect('D9 inside a 60-day window: flagged',       pg_temp.v_state('collected_lot_reclaimed', l), 'open');
END $$;

-- ---------------------------------------------------------------------------
-- Verdict
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_fail TEXT; v_n INT;
BEGIN
  SELECT string_agg(E'\n  ' || msg, ''), count(*) INTO v_fail, v_n FROM _fail;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'collected_item_invariant_monitor: % assertion(s) failed:%', v_n, v_fail;
  END IF;
  RAISE NOTICE 'collected_item_invariant_monitor: all cases OK';
END $$;

ROLLBACK;
