-- Invariant test for mig 0420: on both staff reports,
--
--   lots(All locations) = sum over warehouses of lots(warehouse) + unshelved
--
-- for every worker, where "unshelved" is the worker's lots with no warehouse
-- yet (pending_intake drafts not put away).
--
-- WHAT MOTIVATED IT (prod, 2026-10-13): Tim read 41 under All locations and 36
-- under Crandall; Lane 36 vs 30. Eleven drafts that day had no warehouse, so
-- they counted under All and under no location, and nothing on the page said
-- where the difference went.
--
-- Also pins that 0420 left the existing columns alone: the per-warehouse lots
-- still exclude unshelved drafts, and unshelved is the same number whichever
-- location is selected (it is shown beside a location, never folded into it).
--
-- Runs against the migrated-but-empty CI database, inside a transaction that
-- is ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('c4200000-0000-0000-0000-000000000001', 'unshelvedrpt', 'Unshelved Report Co',
        'unshelved@example.com', 'UNR');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('c4200000-0000-0000-0000-0000000000a1', 'c4200000-0000-0000-0000-000000000001',
        'UNR Crandall', '1 A St', 'Crandall', 'TX', '75114'),
       ('c4200000-0000-0000-0000-0000000000a2', 'c4200000-0000-0000-0000-000000000001',
        'UNR Harrison', '1 B St', 'Harrison', 'AR', '72601');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('c4200000-0000-0000-0000-000000000004', 'unr@example.com');
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('c4200000-0000-0000-0000-000000000001', 'c4200000-0000-0000-0000-000000000004',
        'manager', 'unr@example.com');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'c4200000-0000-0000-0000-000000000004'::uuid $$;

INSERT INTO workers (id, operator_id, display_name, pin_hash, role, is_active)
VALUES ('c4200000-0000-0000-0000-000000000010', 'c4200000-0000-0000-0000-000000000001',
        'Tim', 'x', 'picker', true),
       ('c4200000-0000-0000-0000-000000000011', 'c4200000-0000-0000-0000-000000000001',
        'Lane', 'x', 'picker', true);

-- Tim today: 36 at Crandall, 5 unshelved (the Oct 13 shape: 41 under All).
-- Lane today: 30 at Crandall, 6 unshelved, 2 at Harrison.
-- Plus rows that must count NOWHERE: a deleted unshelved draft and a
-- system_auto relist with no warehouse.
-- Plus one Tim draft 3 days ago (inside 7d/30d, not today).
INSERT INTO lots (operator_id, warehouse_id, lot_code, status, title, lotted_by_worker, created_at)
SELECT 'c4200000-0000-0000-0000-000000000001', wh, 'UNR-' || tag || '-' || g, 'pending_intake',
       'fixture', wid, at
  FROM (VALUES
    ('TC', 36, 'c4200000-0000-0000-0000-0000000000a1'::uuid, 'c4200000-0000-0000-0000-000000000010'::uuid, now()),
    ('TU',  5, NULL::uuid,                                   'c4200000-0000-0000-0000-000000000010'::uuid, now()),
    ('TO',  1, NULL::uuid,                                   'c4200000-0000-0000-0000-000000000010'::uuid, now() - interval '3 days'),
    ('LC', 30, 'c4200000-0000-0000-0000-0000000000a1'::uuid, 'c4200000-0000-0000-0000-000000000011'::uuid, now()),
    ('LU',  6, NULL::uuid,                                   'c4200000-0000-0000-0000-000000000011'::uuid, now()),
    ('LH',  2, 'c4200000-0000-0000-0000-0000000000a2'::uuid, 'c4200000-0000-0000-0000-000000000011'::uuid, now())
  ) AS f(tag, n, wh, wid, at),
  generate_series(1, f.n) AS g;

INSERT INTO lots (operator_id, warehouse_id, lot_code, status, title, lotted_by_worker, deleted_at)
VALUES ('c4200000-0000-0000-0000-000000000001', NULL, 'UNR-DEL', 'pending_intake', 'deleted',
        'c4200000-0000-0000-0000-000000000010', now());
INSERT INTO lots (operator_id, warehouse_id, lot_code, status, title, lotted_by_worker, relist_origin)
VALUES ('c4200000-0000-0000-0000-000000000001', NULL, 'UNR-SYS', 'pending_intake', 'cron',
        'c4200000-0000-0000-0000-000000000010', 'system_auto');

DO $$
DECLARE
  v_fail text := '';
  r      record;
BEGIN
  -- ── worker_productivity: today, 7d and 30d ────────────────────────────────
  FOR r IN
    WITH a AS (SELECT * FROM public.worker_productivity(NULL)),
         c AS (SELECT * FROM public.worker_productivity('c4200000-0000-0000-0000-0000000000a1')),
         h AS (SELECT * FROM public.worker_productivity('c4200000-0000-0000-0000-0000000000a2'))
    SELECT a.display_name,
           a.lots_today AS all_today, c.lots_today + h.lots_today AS wh_today, a.unshelved_today AS u_today,
           a.lots_7d    AS all_7d,    c.lots_7d    + h.lots_7d    AS wh_7d,    a.unshelved_7d    AS u_7d,
           a.lots_30d   AS all_30d,   c.lots_30d   + h.lots_30d   AS wh_30d,   a.unshelved_30d   AS u_30d,
           c.unshelved_30d AS u_30d_c, h.unshelved_30d AS u_30d_h
      FROM a JOIN c USING (worker_id) JOIN h USING (worker_id)
  LOOP
    IF r.all_today <> r.wh_today + r.u_today
       OR r.all_7d <> r.wh_7d + r.u_7d
       OR r.all_30d <> r.wh_30d + r.u_30d THEN
      v_fail := v_fail || format(E'\n  [wp] %s: all %s/%s/%s <> warehouses %s/%s/%s + unshelved %s/%s/%s',
        r.display_name, r.all_today, r.all_7d, r.all_30d, r.wh_today, r.wh_7d, r.wh_30d,
        r.u_today, r.u_7d, r.u_30d);
    END IF;
    IF r.u_30d_c <> r.u_30d OR r.u_30d_h <> r.u_30d THEN
      v_fail := v_fail || format(E'\n  [wp] %s: unshelved depends on location (%s / %s / %s)',
        r.display_name, r.u_30d, r.u_30d_c, r.u_30d_h);
    END IF;
  END LOOP;

  -- Absolute numbers, so a function that returned zeros everywhere cannot pass.
  SELECT * INTO r FROM public.worker_productivity(NULL) WHERE display_name = 'Tim';
  IF r.lots_today <> 41 OR r.unshelved_today <> 5 OR r.lots_30d <> 42 OR r.unshelved_30d <> 6 THEN
    v_fail := v_fail || format(E'\n  [wp] Tim All: today %s (want 41), unshelved today %s (want 5), 30d %s (want 42), unshelved 30d %s (want 6)',
      r.lots_today, r.unshelved_today, r.lots_30d, r.unshelved_30d);
  END IF;
  SELECT * INTO r FROM public.worker_productivity('c4200000-0000-0000-0000-0000000000a1') WHERE display_name = 'Tim';
  IF r.lots_today <> 36 OR r.unshelved_today <> 5 THEN
    v_fail := v_fail || format(E'\n  [wp] Tim Crandall: today %s (want 36 — drafts must not fold in), unshelved %s (want 5)',
      r.lots_today, r.unshelved_today);
  END IF;
  SELECT * INTO r FROM public.worker_productivity('c4200000-0000-0000-0000-0000000000a1') WHERE display_name = 'Lane';
  IF r.lots_today <> 30 OR r.unshelved_today <> 6 THEN
    v_fail := v_fail || format(E'\n  [wp] Lane Crandall: today %s (want 30), unshelved %s (want 6)',
      r.lots_today, r.unshelved_today);
  END IF;

  -- ── worker_daily_productivity: every worker × day cell ────────────────────
  FOR r IN
    WITH a AS (SELECT * FROM public.worker_daily_productivity(NULL, 7, NULL)),
         c AS (SELECT * FROM public.worker_daily_productivity(NULL, 7, 'c4200000-0000-0000-0000-0000000000a1')),
         h AS (SELECT * FROM public.worker_daily_productivity(NULL, 7, 'c4200000-0000-0000-0000-0000000000a2'))
    SELECT a.display_name, a.day, a.lots AS all_lots, c.lots + h.lots AS wh_lots,
           a.unshelved AS u, c.unshelved AS u_c, h.unshelved AS u_h
      FROM a JOIN c USING (worker_id, day) JOIN h USING (worker_id, day)
  LOOP
    IF r.all_lots <> r.wh_lots + r.u THEN
      v_fail := v_fail || format(E'\n  [daily] %s %s: all %s <> warehouses %s + unshelved %s',
        r.display_name, r.day, r.all_lots, r.wh_lots, r.u);
    END IF;
    IF r.u_c <> r.u OR r.u_h <> r.u THEN
      v_fail := v_fail || format(E'\n  [daily] %s %s: unshelved depends on location (%s / %s / %s)',
        r.display_name, r.day, r.u, r.u_c, r.u_h);
    END IF;
  END LOOP;

  SELECT sum(lots) AS l, sum(unshelved) AS u INTO r
    FROM public.worker_daily_productivity(NULL, 7, NULL) WHERE display_name = 'Tim';
  IF r.l <> 42 OR r.u <> 6 THEN
    v_fail := v_fail || format(E'\n  [daily] Tim All 7d: lots %s (want 42), unshelved %s (want 6)', r.l, r.u);
  END IF;
  SELECT sum(lots) AS l, sum(unshelved) AS u INTO r
    FROM public.worker_daily_productivity(NULL, 7, 'c4200000-0000-0000-0000-0000000000a1') WHERE display_name = 'Tim';
  IF r.l <> 36 OR r.u <> 6 THEN
    v_fail := v_fail || format(E'\n  [daily] Tim Crandall 7d: lots %s (want 36), unshelved %s (want 6)', r.l, r.u);
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'worker report unshelved invariant FAILED:%', v_fail;
  END IF;
  RAISE NOTICE 'worker report unshelved invariant: all assertions passed';
END $$;

ROLLBACK;
