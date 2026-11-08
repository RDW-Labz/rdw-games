-- Two-connection behavioural test for mig 0487 (#798 finding 5).
--
-- The on-risk read paths use READ COMMITTED: a competitor (refund, move or a
-- completion RPC) can commit between the rollback's preflight and its writes,
-- or between an RPC's owed-count and its pickups UPDATE. The single-session
-- suite exercises those decisions with fixtures; this file drives the real
-- functions from a SECOND database connection (dblink) so the serialization is
-- proven with real transactions, not a synthetic trigger.
--
-- Covered, both orders for each pair:
--   * refund -> restore        (restore is a complete no-op)
--   * restore -> refund        (both committed, coherent)
--   * move/re-stage -> restore (restore is a complete no-op)
--   * restore -> move          (both committed, coherent)
--   * undo A -> staff_confirm_pickup(final B)
--   * staff_confirm_pickup(both) -> undo A
--   * undo A -> manager_pickup_override(B)
--   * manager_pickup_override(all) -> undo A
--
-- The move/restore middle case uses the documented restore_preflight_only /
-- restore_skip_preflight test hooks to hold the restore transaction open while
-- the second connection commits a new assignment.
--
-- Requires dblink (contrib; present in the pgvector/pg16 CI image). Runs
-- against the migrated CI database, commits its own fixtures, and removes them
-- at the end. Run from the REPO ROOT (the rollback section includes
-- scripts/prod-rig/0487_ROLLBACK_*).

\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS dblink;

-- Session identity the stub auth.uid() reads (same shape as the main test).
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Pre-clean: make the file re-runnable after a failed local attempt.
-- ---------------------------------------------------------------------------
DELETE FROM notifications_outbox
 WHERE idempotency_key LIKE 'pickup_confirmed:staff:b8000000-%';
DELETE FROM operator_audit_log
 WHERE target_id IN (SELECT id FROM invoices WHERE operator_id = 'b8000000-0000-0000-0000-000000000001');
DELETE FROM pickup_sessions WHERE bidder_id = 'b8000000-0000-0000-0000-000000000013';
DELETE FROM pickup_lot_outcomes
 WHERE pickup_id IN (SELECT id FROM pickups WHERE invoice_id IN
   (SELECT id FROM invoices WHERE operator_id = 'b8000000-0000-0000-0000-000000000001'));
DELETE FROM lot_location_events
 WHERE lot_id IN (SELECT id FROM lots WHERE operator_id = 'b8000000-0000-0000-0000-000000000001');
DELETE FROM bin_assignments
 WHERE lot_id IN (SELECT id FROM lots WHERE operator_id = 'b8000000-0000-0000-0000-000000000001');
DELETE FROM pickups WHERE invoice_id IN
  (SELECT id FROM invoices WHERE operator_id = 'b8000000-0000-0000-0000-000000000001');
DELETE FROM invoice_lots WHERE invoice_id IN
  (SELECT id FROM invoices WHERE operator_id = 'b8000000-0000-0000-0000-000000000001');
DELETE FROM invoices WHERE operator_id = 'b8000000-0000-0000-0000-000000000001';
DELETE FROM lots WHERE operator_id = 'b8000000-0000-0000-0000-000000000001';
DELETE FROM auctions WHERE operator_id = 'b8000000-0000-0000-0000-000000000001';
DELETE FROM bidders WHERE id = 'b8000000-0000-0000-0000-000000000013';
DELETE FROM operator_users WHERE operator_id = 'b8000000-0000-0000-0000-000000000001';
DELETE FROM auth.users WHERE id IN (
  'b8000000-0000-0000-0000-000000000010',
  'b8000000-0000-0000-0000-000000000011',
  'b8000000-0000-0000-0000-000000000012',
  'b8000000-0000-0000-0000-000000000013');
DELETE FROM bins WHERE warehouse_id = 'b8000000-0000-0000-0000-000000000002';
DELETE FROM warehouses WHERE id = 'b8000000-0000-0000-0000-000000000002';
DELETE FROM operators WHERE id = 'b8000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- Committed fixtures (unique b8… ids; cleaned up at the end)
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('b8000000-0000-0000-0000-000000000001', 'rctest', 'RC Co', 'rc@example.com', 'RCT');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('b8000000-0000-0000-0000-000000000002', 'b8000000-0000-0000-0000-000000000001',
        'RC WH', '2 R St', 'Harrison', 'AR', '72601');

INSERT INTO bins (id, warehouse_id, code, aisle, x_px, y_px) VALUES
  ('b8000000-0000-0000-0000-000000000003', 'b8000000-0000-0000-0000-000000000002',
   'R-01-1-01', 'R', 0, 0),
  ('b8000000-0000-0000-0000-000000000004', 'b8000000-0000-0000-0000-000000000002',
   'R-02-2-02', 'R', 0, 0);

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;

INSERT INTO auth.users (id, email) VALUES
  ('b8000000-0000-0000-0000-000000000010', 'rc-admin@example.com'),  ('b8000000-0000-0000-0000-000000000011', 'rc-manager@example.com'),
  ('b8000000-0000-0000-0000-000000000012', 'rc-picker@example.com'),
  ('b8000000-0000-0000-0000-000000000013', 'rc-buyer@example.com');

INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
  ('b8000000-0000-0000-0000-000000000001', 'b8000000-0000-0000-0000-000000000010', 'admin', 'rc-admin@example.com'),
  ('b8000000-0000-0000-0000-000000000001', 'b8000000-0000-0000-0000-000000000011', 'manager', 'rc-manager@example.com'),
  ('b8000000-0000-0000-0000-000000000001', 'b8000000-0000-0000-0000-000000000012', 'picker', 'rc-picker@example.com');

INSERT INTO bidders (id, email, birth_date)
VALUES ('b8000000-0000-0000-0000-000000000013', 'rc-buyer@example.com', DATE '1990-01-01');

-- One auction per invoice (invoices are UNIQUE (auction_id, bidder_id)).
INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at)
SELECT ('b8000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       'b8000000-0000-0000-0000-000000000001',
       'b8000000-0000-0000-0000-000000000002',
       'RC auction ' || n, 'draft',
       now(), now() + interval '2 days', now() + interval '3 days',
       now() + interval '4 days'
  FROM generate_series(101, 109) AS n;

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, paid_at, total_cents)
SELECT ('b8000000-0000-0000-0000-' || lpad((n + 100)::text, 12, '0'))::uuid,
       'b8000000-0000-0000-0000-000000000001',
       ('b8000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       'b8000000-0000-0000-0000-000000000013', 'paid', now(), 2000
  FROM generate_series(101, 109) AS n;

-- Line A per scenario.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, title, status)
SELECT ('b8000000-0000-0000-0000-' || lpad((n + 200)::text, 12, '0'))::uuid,
       'b8000000-0000-0000-0000-000000000001',
       'b8000000-0000-0000-0000-000000000002',
       'RC-' || n || '-A', 'rc line A ' || n, 'won'
  FROM generate_series(101, 109) AS n;

-- Line B exists only for the four completion-RPC scenarios (105..108).
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, title, status)
SELECT ('b8000000-0000-0000-0000-' || lpad((n + 300)::text, 12, '0'))::uuid,
       'b8000000-0000-0000-0000-000000000001',
       'b8000000-0000-0000-0000-000000000002',
       'RC-' || n || '-B', 'rc line B ' || n, 'won'
  FROM generate_series(105, 108) AS n;

-- Initial handover state.
--   101..104: same-line restore fixtures — A stamped, visit completed.
--   105/107: A+B stamped, visit completed (an undo of A happens first).
--   106/108: A+B owed, visit checked_in (the RPC completes first).
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at)
SELECT ('b8000000-0000-0000-0000-' || lpad((n + 100)::text, 12, '0'))::uuid,
       ('b8000000-0000-0000-0000-' || lpad((n + 200)::text, 12, '0'))::uuid,
       1000,
       CASE WHEN n IN (106, 108) THEN NULL ELSE now() END
  FROM generate_series(101, 109) AS n;

INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at)
SELECT ('b8000000-0000-0000-0000-' || lpad((n + 100)::text, 12, '0'))::uuid,
       ('b8000000-0000-0000-0000-' || lpad((n + 300)::text, 12, '0'))::uuid,
       1000,
       CASE WHEN n IN (106, 108) THEN NULL ELSE now() END
  FROM generate_series(105, 108) AS n;

INSERT INTO pickups (id, invoice_id, warehouse_id, status, checked_in_at, completed_at)
SELECT ('b8000000-0000-0000-0000-' || lpad((n + 400)::text, 12, '0'))::uuid,
       ('b8000000-0000-0000-0000-' || lpad((n + 100)::text, 12, '0'))::uuid,
       'b8000000-0000-0000-0000-000000000002',
       (CASE WHEN n IN (106, 108) THEN 'checked_in' ELSE 'completed' END)::pickup_status,
       now(),
       CASE WHEN n IN (106, 108) THEN NULL ELSE now() END
  FROM generate_series(101, 109) AS n;

INSERT INTO bin_assignments (lot_id, bin_id, status, assigned_at, picked_up_at)
SELECT ('b8000000-0000-0000-0000-' || lpad((n + 200)::text, 12, '0'))::uuid,
       'b8000000-0000-0000-0000-000000000003',
       (CASE WHEN n IN (106, 108) THEN 'staged' ELSE 'picked_up' END)::bin_assignment_status,
       now(),
       CASE WHEN n IN (106, 108) THEN NULL ELSE now() END
  FROM generate_series(101, 109) AS n;

INSERT INTO bin_assignments (lot_id, bin_id, status, assigned_at, picked_up_at)
SELECT ('b8000000-0000-0000-0000-' || lpad((n + 300)::text, 12, '0'))::uuid,
       'b8000000-0000-0000-0000-000000000003',
       (CASE WHEN n IN (106, 108) THEN 'staged' ELSE 'picked_up' END)::bin_assignment_status,
       now(),
       CASE WHEN n IN (106, 108) THEN NULL ELSE now() END
  FROM generate_series(105, 108) AS n;

-- Wrong collected outcomes, one per stamped line (106/108 start owed).
INSERT INTO pickup_lot_outcomes (pickup_id, lot_id, outcome)
SELECT ('b8000000-0000-0000-0000-' || lpad((n + 400)::text, 12, '0'))::uuid,
       ('b8000000-0000-0000-0000-' || lpad((n + 200)::text, 12, '0'))::uuid,
       'collected'
  FROM generate_series(101, 109) AS n
 WHERE n NOT IN (106, 108);

INSERT INTO pickup_lot_outcomes (pickup_id, lot_id, outcome)
SELECT ('b8000000-0000-0000-0000-' || lpad((n + 400)::text, 12, '0'))::uuid,
       ('b8000000-0000-0000-0000-' || lpad((n + 300)::text, 12, '0'))::uuid,
       'collected'
  FROM generate_series(105, 108) AS n
 WHERE n NOT IN (106, 108);

-- ---------------------------------------------------------------------------
-- Second connection
-- ---------------------------------------------------------------------------
SELECT dblink_connect('race', 'dbname=' || current_database() || ' user=' || current_user);
SELECT dblink_exec('race', 'SET test.uid = ''b8000000-0000-0000-0000-000000000010''');

-- Main session acts as the admin.
SELECT set_config('test.uid', 'b8000000-0000-0000-0000-000000000010', false);

-- Helpers keep the scenario blocks short.
CREATE OR REPLACE FUNCTION _0487_race_undo(p_invoice uuid, p_lot uuid, p_reason text)
RETURNS void LANGUAGE sql AS $$
  SELECT 1 FROM dblink('race',
    format('SELECT undo_invoice_line_pickup(%L, %L, %L)::text',
           p_invoice, p_lot, p_reason)) AS t(r text);
$$;

CREATE OR REPLACE FUNCTION _0487_race_assert(p_ok boolean, p_msg text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT p_ok THEN
    RAISE EXCEPTION '0487 concurrency: %', p_msg;
  END IF;
END $$;

-- ===========================================================================
-- 1. refund commits first -> restore is a complete no-op
-- ===========================================================================
SELECT _0487_race_undo('b8000000-0000-0000-0000-000000000201',
                       'b8000000-0000-0000-0000-000000000301',
                       'wrong lot scanned at the counter');

SELECT dblink_exec('race', 'BEGIN');
SELECT dblink_exec('race', $sql$
  UPDATE invoice_lots SET refunded_at = clock_timestamp()
   WHERE invoice_id = 'b8000000-0000-0000-0000-000000000201'
     AND lot_id = 'b8000000-0000-0000-0000-000000000301'
$sql$);

-- The refund holds the line lock, so the restore's preflight would wait, not
-- read a stale snapshot. A NOWAIT attempt in this session proves it.
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM invoice_lots
     WHERE invoice_id = 'b8000000-0000-0000-0000-000000000201'
       AND lot_id = 'b8000000-0000-0000-0000-000000000301'
     FOR UPDATE NOWAIT;
    RAISE EXCEPTION 'expected the refund connection to hold the line lock';
  EXCEPTION WHEN lock_not_available THEN
    NULL;
  END;
END $$;

SELECT dblink_exec('race', 'COMMIT');

SELECT a.id AS restore_audit_id
  FROM operator_audit_log a
 WHERE a.action_type = 'invoice_line.pickup_undone'
   AND a.target_id = 'b8000000-0000-0000-0000-000000000201'
   AND a.before_state->>'lot_id' = 'b8000000-0000-0000-0000-000000000301'
 ORDER BY a.created_at DESC, a.id DESC
 LIMIT 1
\gset
\set keep_function 1
BEGIN;
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql
COMMIT;

SELECT _0487_race_assert(
  (SELECT picked_up_at FROM invoice_lots
    WHERE invoice_id = 'b8000000-0000-0000-0000-000000000201'
      AND lot_id = 'b8000000-0000-0000-0000-000000000301') IS NULL,
  'refund-first restore stamped the refunded line');

SELECT _0487_race_assert(
  NOT EXISTS (SELECT 1 FROM pickup_lot_outcomes
               WHERE pickup_id = 'b8000000-0000-0000-0000-000000000501'
                 AND lot_id = 'b8000000-0000-0000-0000-000000000301'),
  'refund-first restore re-added the collected outcome');

-- ===========================================================================
-- 2. restore commits first, then the refund lands; both are coherent
-- ===========================================================================
SELECT _0487_race_undo('b8000000-0000-0000-0000-000000000202',
                       'b8000000-0000-0000-0000-000000000302',
                       'wrong lot scanned at the counter');

SELECT a.id AS restore_audit_id
  FROM operator_audit_log a
 WHERE a.action_type = 'invoice_line.pickup_undone'
   AND a.target_id = 'b8000000-0000-0000-0000-000000000202'
   AND a.before_state->>'lot_id' = 'b8000000-0000-0000-0000-000000000302'
 ORDER BY a.created_at DESC, a.id DESC
 LIMIT 1
\gset
BEGIN;
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql
COMMIT;

SELECT dblink_exec('race', $sql$
  UPDATE invoice_lots SET refunded_at = clock_timestamp()
   WHERE invoice_id = 'b8000000-0000-0000-0000-000000000202'
     AND lot_id = 'b8000000-0000-0000-0000-000000000302'
$sql$);

SELECT _0487_race_assert(
  (SELECT picked_up_at FROM invoice_lots
    WHERE invoice_id = 'b8000000-0000-0000-0000-000000000202'
      AND lot_id = 'b8000000-0000-0000-0000-000000000302') IS NOT NULL,
  'restore-then-refund lost the restored line stamp');

SELECT _0487_race_assert(
  EXISTS (SELECT 1 FROM pickup_lot_outcomes
           WHERE pickup_id = 'b8000000-0000-0000-0000-000000000502'
             AND lot_id = 'b8000000-0000-0000-0000-000000000302'
             AND outcome = 'collected'),
  'restore-then-refund lost the restored collected outcome');

-- ===========================================================================
-- 3. a move/re-stage arrives BETWEEN the restore preflight and its writes.
--    The preflight holds the line/lot/bin rows, so the competing insert BLOCKS
--    (two real connections) instead of becoming a half-applied restore; the
--    restore commits first and the move then applies on top.
-- ===========================================================================
SELECT _0487_race_undo('b8000000-0000-0000-0000-000000000203',
                       'b8000000-0000-0000-0000-000000000303',
                       'wrong lot scanned at the counter');

SELECT a.id AS restore_audit_id
  FROM operator_audit_log a
 WHERE a.action_type = 'invoice_line.pickup_undone'
   AND a.target_id = 'b8000000-0000-0000-0000-000000000203'
   AND a.before_state->>'lot_id' = 'b8000000-0000-0000-0000-000000000303'
 ORDER BY a.created_at DESC, a.id DESC
 LIMIT 1
\gset

BEGIN;
\set restore_preflight_only 1
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql
\unset restore_preflight_only

-- Second connection starts the move while the restore transaction is open.
SELECT dblink_send_query('race', $sql$
  INSERT INTO bin_assignments (lot_id, bin_id, status, assigned_at, picked_up_at)
  VALUES ('b8000000-0000-0000-0000-000000000303',
          'b8000000-0000-0000-0000-000000000004', 'staged',
          clock_timestamp(), NULL)
$sql$);

-- The preflight holds the lot row, so the competing insert must be waiting on
-- a lock (FK key-share vs FOR UPDATE) rather than committing mid-restore.
DO $$
DECLARE
  v_blocked boolean := false;
BEGIN
  FOR i IN 1..60 LOOP
    SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND query LIKE '%INSERT INTO bin_assignments%'
         AND wait_event_type = 'Lock'
    ) INTO v_blocked;
    EXIT WHEN v_blocked;
    PERFORM pg_sleep(0.05);
  END LOOP;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'the move did not block on the restore preflight';
  END IF;
END $$;

\set restore_skip_preflight 1
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql
\unset restore_skip_preflight
COMMIT;

-- The waiting insert now completes on the committed restore. Consume both
-- the command tag result and the final empty result so the connection is idle.
SELECT * FROM dblink_get_result('race') AS t(r text);
SELECT * FROM dblink_get_result('race') AS t(r text);

SELECT _0487_race_assert(
  (SELECT picked_up_at FROM invoice_lots
    WHERE invoice_id = 'b8000000-0000-0000-0000-000000000203'
      AND lot_id = 'b8000000-0000-0000-0000-000000000303') IS NOT NULL,
  'the serialized restore did not stamp the line');

SELECT _0487_race_assert(
  (SELECT status::text FROM bin_assignments
    WHERE lot_id = 'b8000000-0000-0000-0000-000000000303'
      AND bin_id = 'b8000000-0000-0000-0000-000000000004') = 'staged',
  'the move that waited on the restore was not applied');

-- ===========================================================================
-- 4. restore commits first, then the move; both are coherent
-- ===========================================================================
SELECT _0487_race_undo('b8000000-0000-0000-0000-000000000204',
                       'b8000000-0000-0000-0000-000000000304',
                       'wrong lot scanned at the counter');

SELECT a.id AS restore_audit_id
  FROM operator_audit_log a
 WHERE a.action_type = 'invoice_line.pickup_undone'
   AND a.target_id = 'b8000000-0000-0000-0000-000000000204'
   AND a.before_state->>'lot_id' = 'b8000000-0000-0000-0000-000000000304'
 ORDER BY a.created_at DESC, a.id DESC
 LIMIT 1
\gset
BEGIN;
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql
COMMIT;

SELECT dblink_exec('race', $sql$
  INSERT INTO bin_assignments (lot_id, bin_id, status, assigned_at, picked_up_at)
  VALUES ('b8000000-0000-0000-0000-000000000304',
          'b8000000-0000-0000-0000-000000000004', 'staged',
          clock_timestamp(), NULL)
$sql$);

SELECT _0487_race_assert(
  (SELECT picked_up_at FROM invoice_lots
    WHERE invoice_id = 'b8000000-0000-0000-0000-000000000204'
      AND lot_id = 'b8000000-0000-0000-0000-000000000304') IS NOT NULL,
  'restore-then-move lost the line stamp');

SELECT _0487_race_assert(
  (SELECT status::text FROM bin_assignments
    WHERE lot_id = 'b8000000-0000-0000-0000-000000000304'
      AND bin_id = 'b8000000-0000-0000-0000-000000000003'
    ORDER BY assigned_at DESC, id DESC LIMIT 1) = 'picked_up',
  'restore-then-move lost the restored bin row');

-- ===========================================================================
-- 5. undo A commits on the second connection, then staff_confirm_pickup(B)
-- ===========================================================================
SELECT _0487_race_undo('b8000000-0000-0000-0000-000000000205',
                       'b8000000-0000-0000-0000-000000000305',
                       'wrong lot scanned at the counter');

DO $$
DECLARE
  v_res staff_confirm_pickup_result;
BEGIN
  v_res := staff_confirm_pickup(
    'b8000000-0000-0000-0000-000000000205',
    ARRAY['RC-105-B']::text[], TRUE);
  IF v_res.out_warning IS NULL OR v_res.out_warning NOT LIKE '%partial%' THEN
    RAISE EXCEPTION 'staff RPC after a real undo did not report a partial round (%)',
      v_res.out_warning;
  END IF;
  IF v_res.out_lots_picked_count <> 0 THEN
    RAISE EXCEPTION 'staff RPC counted an already-stamped line as newly picked (%)',
      v_res.out_lots_picked_count;
  END IF;
END $$;

SELECT _0487_race_assert(
  (SELECT status::text FROM pickups
    WHERE id = 'b8000000-0000-0000-0000-000000000505') = 'checked_in',
  'staff RPC completed the visit while line A was owed');

SELECT _0487_race_assert(
  NOT EXISTS (SELECT 1 FROM notifications_outbox
               WHERE idempotency_key =
                     'pickup_confirmed:staff:b8000000-0000-0000-0000-000000000205'),
  'staff RPC queued a completion notification while line A was owed');

-- ===========================================================================
-- 6. staff_confirm_pickup completes both lines, then undo A reopens the visit
-- ===========================================================================
DO $$
DECLARE
  v_res staff_confirm_pickup_result;
BEGIN
  v_res := staff_confirm_pickup(
    'b8000000-0000-0000-0000-000000000206',
    ARRAY['RC-106-A','RC-106-B']::text[], FALSE);
  IF (SELECT status::text FROM pickups
       WHERE id = 'b8000000-0000-0000-0000-000000000506') <> 'completed' THEN
    RAISE EXCEPTION 'staff RPC did not complete an owed visit (%)', v_res.out_warning;
  END IF;
  IF v_res.out_lots_picked_count <> 2 OR v_res.out_warning IS NOT NULL THEN
    RAISE EXCEPTION 'staff RPC returned a partial result on a full completion (% / %)',
      v_res.out_lots_picked_count, v_res.out_warning;
  END IF;
END $$;

SELECT _0487_race_assert(
  EXISTS (SELECT 1 FROM notifications_outbox
           WHERE idempotency_key =
                 'pickup_confirmed:staff:b8000000-0000-0000-0000-000000000206'),
  'staff RPC did not queue pickup_confirmed on a real completion');

SELECT _0487_race_undo('b8000000-0000-0000-0000-000000000206',
                       'b8000000-0000-0000-0000-000000000306',
                       'wrong lot scanned at the counter');

SELECT _0487_race_assert(
  (SELECT status::text FROM pickups
    WHERE id = 'b8000000-0000-0000-0000-000000000506') = 'checked_in',
  'the undo did not reopen a completed visit');

SELECT _0487_race_assert(
  (SELECT picked_up_at FROM invoice_lots
    WHERE invoice_id = 'b8000000-0000-0000-0000-000000000206'
      AND lot_id = 'b8000000-0000-0000-0000-000000000306') IS NULL,
  'the undo did not clear the stamped line');

-- ===========================================================================
-- 7. undo A commits, then manager_pickup_override(B) must not announce it
-- ===========================================================================
SELECT _0487_race_undo('b8000000-0000-0000-0000-000000000207',
                       'b8000000-0000-0000-0000-000000000307',
                       'wrong lot scanned at the counter');

DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := manager_pickup_override(
    'b8000000-0000-0000-0000-000000000207',
    ARRAY['b8000000-0000-0000-0000-000000000407']::uuid[],
    'system_glitch', NULL);
  IF v_res->>'pickup_completed' <> 'false' THEN
    RAISE EXCEPTION 'manager override reported a refused completion (%)', v_res;
  END IF;
  IF (v_res->>'remaining_count')::int < 1 THEN
    RAISE EXCEPTION 'manager override hid the owed undone line (%)', v_res;
  END IF;
  IF (v_res->>'picked_count')::int <> 0 THEN
    RAISE EXCEPTION 'manager override counted an already-stamped line (%)', v_res;
  END IF;
END $$;

SELECT _0487_race_assert(
  (SELECT status::text FROM pickups
    WHERE id = 'b8000000-0000-0000-0000-000000000507') = 'checked_in',
  'manager override completed the visit while line A was owed');

SELECT _0487_race_assert(
  NOT EXISTS (SELECT 1 FROM notifications_outbox
               WHERE idempotency_key =
                     'pickup_confirmed:staff:b8000000-0000-0000-0000-000000000207'),
  'manager override queued a completion notification while line A was owed');

-- ===========================================================================
-- 8. manager override completes both lines, then undo A reopens the visit
-- ===========================================================================
DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := manager_pickup_override(
    'b8000000-0000-0000-0000-000000000208', NULL, 'system_glitch', NULL);
  IF v_res->>'pickup_completed' <> 'true' THEN
    RAISE EXCEPTION 'manager override did not complete an owed visit (%)', v_res;
  END IF;
  IF (v_res->>'picked_count')::int <> 2 THEN
    RAISE EXCEPTION 'manager override returned the wrong picked_count (%)', v_res;
  END IF;
END $$;

SELECT _0487_race_assert(
  EXISTS (SELECT 1 FROM notifications_outbox
           WHERE idempotency_key =
                 'pickup_confirmed:staff:b8000000-0000-0000-0000-000000000208'),
  'manager override did not queue pickup_confirmed on a real completion');

SELECT _0487_race_undo('b8000000-0000-0000-0000-000000000208',
                       'b8000000-0000-0000-0000-000000000308',
                       'wrong lot scanned at the counter');

SELECT _0487_race_assert(
  (SELECT status::text FROM pickups
    WHERE id = 'b8000000-0000-0000-0000-000000000508') = 'checked_in',
  'the undo did not reopen a manager-completed visit');

-- ===========================================================================
-- 9. transaction-start order opposite action order (findings 2 and 3)
-- ===========================================================================
-- B begins its transaction first. A then undoes and commits, a genuine later
-- handover is recorded, and B undoes LAST from the transaction that started
-- earlier. clock_timestamp() must rank B as the newer event, so replaying A's
-- older audit is a complete no-op.
SELECT dblink_exec('race', 'BEGIN');

-- A's undo runs on the MAIN connection and commits; B's transaction (started
-- above, so its now() is older) does nothing until its own undo below.
SELECT undo_invoice_line_pickup(
  'b8000000-0000-0000-0000-000000000209',
  'b8000000-0000-0000-0000-000000000309',
  'wrong lot scanned at the counter');

-- Genuine later handover: the line is still unstamped, and the decision is
-- recorded after A's undo, so the completion guard must let the pickups
-- UPDATE through (0356 then stamps the line).
INSERT INTO pickup_lot_outcomes (pickup_id, lot_id, outcome, decided_by)
VALUES ('b8000000-0000-0000-0000-000000000509',
        'b8000000-0000-0000-0000-000000000309', 'collected',
        'b8000000-0000-0000-0000-000000000010');
UPDATE pickups SET status = 'completed', completed_at = clock_timestamp()
 WHERE id = 'b8000000-0000-0000-0000-000000000509';

SELECT _0487_race_assert(
  (SELECT status::text FROM pickups
    WHERE id = 'b8000000-0000-0000-0000-000000000509') = 'completed',
  'a genuine later handover was blocked');

-- B's undo runs inside the transaction that began before A's undo.
SELECT * FROM dblink('race', $sql$
  SELECT undo_invoice_line_pickup(
    'b8000000-0000-0000-0000-000000000209',
    'b8000000-0000-0000-0000-000000000309',
    'second wrong scan')::text
$sql$) AS t(r text);
SELECT dblink_exec('race', 'COMMIT');

DO $$
DECLARE
  v_a timestamptz;
  v_b timestamptz;
BEGIN
  SELECT created_at INTO v_a FROM operator_audit_log
   WHERE action_type = 'invoice_line.pickup_undone'
     AND target_id = 'b8000000-0000-0000-0000-000000000209'
     AND before_state->>'lot_id' = 'b8000000-0000-0000-0000-000000000309'
   ORDER BY id ASC LIMIT 1;
  SELECT created_at INTO v_b FROM operator_audit_log
   WHERE action_type = 'invoice_line.pickup_undone'
     AND target_id = 'b8000000-0000-0000-0000-000000000209'
     AND before_state->>'lot_id' = 'b8000000-0000-0000-0000-000000000309'
   ORDER BY id DESC LIMIT 1;
  IF v_b <= v_a THEN
    RAISE EXCEPTION 'event time did not order the undos (% <= %)', v_b, v_a;
  END IF;
END $$;

-- Replaying A's older audit must not re-add the outcome or stamp the line:
-- B's undo is the newest event.
SELECT a.id AS restore_audit_id
  FROM operator_audit_log a
 WHERE a.action_type = 'invoice_line.pickup_undone'
   AND a.target_id = 'b8000000-0000-0000-0000-000000000209'
   AND a.before_state->>'lot_id' = 'b8000000-0000-0000-0000-000000000309'
 ORDER BY a.id ASC
 LIMIT 1
\gset
BEGIN;
\i scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql
COMMIT;

SELECT _0487_race_assert(
  (SELECT picked_up_at FROM invoice_lots
    WHERE invoice_id = 'b8000000-0000-0000-0000-000000000209'
      AND lot_id = 'b8000000-0000-0000-0000-000000000309') IS NULL,
  'an older audit replay stamped a line undone again later');

SELECT _0487_race_assert(
  NOT EXISTS (SELECT 1 FROM pickup_lot_outcomes
               WHERE pickup_id = 'b8000000-0000-0000-0000-000000000509'
                 AND lot_id = 'b8000000-0000-0000-0000-000000000309'),
  'an older audit replay re-added a removed outcome');

-- Stale control after the inversion: a collected decision older than the
-- newest undo still blocks completion.
INSERT INTO pickup_lot_outcomes
  (pickup_id, lot_id, outcome, decided_by, created_at, decided_at)
VALUES ('b8000000-0000-0000-0000-000000000509',
        'b8000000-0000-0000-0000-000000000309', 'collected',
        'b8000000-0000-0000-0000-000000000010',
        clock_timestamp() - interval '1 hour',
        clock_timestamp() - interval '1 hour');
UPDATE pickups SET status = 'completed', completed_at = clock_timestamp()
 WHERE id = 'b8000000-0000-0000-0000-000000000509';

SELECT _0487_race_assert(
  (SELECT status::text FROM pickups
    WHERE id = 'b8000000-0000-0000-0000-000000000509') = 'checked_in',
  'a stale collected decision completed the visit after the inversion');

DO $$ BEGIN
  RAISE NOTICE '0487 #798: two-connection refund/move/completion races OK';
END $$;

-- ---------------------------------------------------------------------------
-- Cleanup (committed fixtures)
-- ---------------------------------------------------------------------------
SELECT dblink_disconnect('race');
DROP FUNCTION IF EXISTS _0487_race_undo(uuid, uuid, text);
DROP FUNCTION IF EXISTS _0487_race_assert(boolean, text);

DELETE FROM notifications_outbox
 WHERE idempotency_key LIKE 'pickup_confirmed:staff:b8000000-%';
DELETE FROM operator_audit_log
 WHERE target_id IN (SELECT id FROM invoices WHERE operator_id = 'b8000000-0000-0000-0000-000000000001');
DELETE FROM pickup_sessions WHERE bidder_id = 'b8000000-0000-0000-0000-000000000013';
DELETE FROM pickup_lot_outcomes
 WHERE pickup_id IN (SELECT id FROM pickups WHERE invoice_id IN
   (SELECT id FROM invoices WHERE operator_id = 'b8000000-0000-0000-0000-000000000001'));
DELETE FROM lot_location_events
 WHERE lot_id IN (SELECT id FROM lots WHERE operator_id = 'b8000000-0000-0000-0000-000000000001');
DELETE FROM bin_assignments
 WHERE lot_id IN (SELECT id FROM lots WHERE operator_id = 'b8000000-0000-0000-0000-000000000001');
DELETE FROM pickups WHERE invoice_id IN
  (SELECT id FROM invoices WHERE operator_id = 'b8000000-0000-0000-0000-000000000001');
DELETE FROM invoice_lots WHERE invoice_id IN
  (SELECT id FROM invoices WHERE operator_id = 'b8000000-0000-0000-0000-000000000001');
DELETE FROM invoices WHERE operator_id = 'b8000000-0000-0000-0000-000000000001';
DELETE FROM lots WHERE operator_id = 'b8000000-0000-0000-0000-000000000001';
DELETE FROM auctions WHERE operator_id = 'b8000000-0000-0000-0000-000000000001';
DELETE FROM bidders WHERE id = 'b8000000-0000-0000-0000-000000000013';
DELETE FROM operator_users WHERE operator_id = 'b8000000-0000-0000-0000-000000000001';
DELETE FROM auth.users WHERE id IN (
  'b8000000-0000-0000-0000-000000000010',
  'b8000000-0000-0000-0000-000000000011',
  'b8000000-0000-0000-0000-000000000012',
  'b8000000-0000-0000-0000-000000000013');
DELETE FROM bins WHERE warehouse_id = 'b8000000-0000-0000-0000-000000000002';
DELETE FROM warehouses WHERE id = 'b8000000-0000-0000-0000-000000000002';
DELETE FROM operators WHERE id = 'b8000000-0000-0000-0000-000000000001';

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULL::uuid $$;
