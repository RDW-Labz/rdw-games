-- RLS + constraint matrix for 0457. t(name, role, uid, sql, expect) runs sql
-- as the given role with request.jwt.claim.sub set to uid, and compares the
-- resulting SQLSTATE ('ok' if no error) to expect. Mirrors
-- scripts/prod-rig/0435-rig/cases.sql's pg_temp.t() pattern. uid is passed
-- separately (not interpolated into the dollar-quoted sql -- psql does not
-- interpolate :vars inside $$-quoted text, confirmed empirically).
CREATE OR REPLACE FUNCTION pg_temp.t(p_name text, p_role text, p_uid text, p_sql text, p_expect text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text := 'ok';
BEGIN
  BEGIN
    IF p_uid IS NOT NULL THEN
      PERFORM set_config('request.jwt.claim.sub', p_uid, true);
    END IF;
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE p_sql;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN v := SQLSTATE; RESET ROLE;
  END;
  RETURN CASE WHEN v = p_expect THEN 'PASS ' ELSE 'FAIL ' END || p_name || ' (got ' || v || ', want ' || p_expect || ')';
END $$;

-- uids: a1/a2 = operators A/B. b1/b2 = warehouses (b1 under A, b2 under B).
-- c1=opA admin, c2=opA manager, c3=opA picker, c4=opB admin.
-- d1=bidder1 (waitlisted at opA), d2=bidder2 (unrelated).

-- =========================================================================
-- 1. operator_pro_plans: new columns, CHECK constraints, defaults
-- =========================================================================

SELECT pg_temp.t('minimal plan insert gets Member Pro defaults', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Pro')$q$, 'ok');
SELECT 'defaults: price=' || price_cents || ' active=' || active || ' interval=' || billing_interval || ' intro_price=' ||
  intro_price_cents || ' intro_months=' || intro_months || ' intro_seats=' || intro_seats || ' member_cap=' || member_cap || ' grace_days=' ||
  past_due_grace_days || ' early_min=' || early_access_minutes || ' inspection=' || perk_inspection_before_pickup || ' slots=' ||
  perk_scheduled_pickup_slots || ' early_access=' || perk_early_building_access || ' pickup_window=' || perk_longer_pickup_window || ' grace_perk=' ||
  perk_payment_grace || ' staging=' || staging_prep
  FROM operator_pro_plans WHERE operator_id = '00000000-0000-0000-0000-0000000000a1';

SELECT pg_temp.t('price_cents 0 rejected', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, price_cents) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', 0)$q$, '23514');
SELECT pg_temp.t('price_cents 100001 rejected (above ceiling)', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, price_cents) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', 100001)$q$, '23514');
SELECT pg_temp.t('price_cents 100000 accepted (at ceiling)', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, price_cents) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Ceiling', 100000)$q$, 'ok');
SELECT pg_temp.t('billing_interval invalid rejected', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, billing_interval) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', 'week')$q$, '23514');
SELECT pg_temp.t('intro_months 0 rejected', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, intro_months) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', 0)$q$, '23514');
SELECT pg_temp.t('intro_seats negative rejected', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, intro_seats) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', -1)$q$, '23514');
SELECT pg_temp.t('member_cap 0 rejected', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, member_cap) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', 0)$q$, '23514');
SELECT pg_temp.t('member_cap over max rejected', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, member_cap) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', 5001)$q$, '23514');
SELECT pg_temp.t('past_due_grace_days negative rejected', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, past_due_grace_days) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', -1)$q$, '23514');
SELECT pg_temp.t('early_access_minutes over max rejected', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, early_access_minutes) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', 241)$q$, '23514');

-- RLS: operator A staff (admin/manager) can read/update their own plan;
-- picker cannot write; operator B cannot read or write it.
SELECT pg_temp.t('opA admin reads own plan', 'authenticated', '00000000-0000-0000-0000-0000000000c1',
  $q$DO $z$ BEGIN IF (SELECT count(*) FROM operator_pro_plans WHERE operator_id = '00000000-0000-0000-0000-0000000000a1') < 1 THEN RAISE EXCEPTION 'expected row'; END IF; END $z$$q$, 'ok');
SELECT pg_temp.t('opB admin cannot read opA plan (no leak)', 'authenticated', '00000000-0000-0000-0000-0000000000c4',
  $q$DO $z$ BEGIN IF EXISTS (SELECT 1 FROM operator_pro_plans WHERE operator_id = '00000000-0000-0000-0000-0000000000a1') THEN RAISE EXCEPTION 'leak'; END IF; END $z$$q$, 'ok');
SELECT pg_temp.t('opA manager updates plan settings', 'authenticated', '00000000-0000-0000-0000-0000000000c2',
  $q$UPDATE operator_pro_plans SET member_cap = 25 WHERE operator_id = '00000000-0000-0000-0000-0000000000a1' AND name = 'Pro'$q$, 'ok');
-- A picker's UPDATE matches 0 rows under RLS (the USING clause excludes
-- non-admin/manager roles, so the row is invisible to the update, not an
-- error) -- confirmed empirically (RLS silently filters, it does not raise
-- 42501, unlike an INSERT's WITH CHECK). So this asserts "no row changed",
-- not "statement errored".
SELECT pg_temp.t('opA picker cannot change plan settings (write silently filtered)', 'authenticated', '00000000-0000-0000-0000-0000000000c3',
  $q$DO $z$ BEGIN
    UPDATE operator_pro_plans SET member_cap = 10 WHERE operator_id = '00000000-0000-0000-0000-0000000000a1' AND name = 'Pro';
    IF (SELECT member_cap FROM operator_pro_plans WHERE operator_id = '00000000-0000-0000-0000-0000000000a1' AND name = 'Pro') = 10 THEN
      RAISE EXCEPTION 'picker was able to write member_cap';
    END IF;
  END $z$$q$, 'ok');
SELECT pg_temp.t('opB admin update of opA plan is a no-op under RLS (not an error)', 'authenticated', '00000000-0000-0000-0000-0000000000c4',
  $q$UPDATE operator_pro_plans SET member_cap = 10 WHERE operator_id = '00000000-0000-0000-0000-0000000000a1' AND name = 'Pro'$q$, 'ok');
SELECT 'member_cap after opB no-op update (should stay 25, not 10): ' || member_cap FROM operator_pro_plans WHERE operator_id = '00000000-0000-0000-0000-0000000000a1' AND name = 'Pro';

-- =========================================================================
-- 2. member_warehouse_settings
-- =========================================================================
SELECT pg_temp.t('opA admin creates warehouse settings for own warehouse', 'authenticated', '00000000-0000-0000-0000-0000000000c1',
  $q$INSERT INTO member_warehouse_settings (operator_id, warehouse_id) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1')$q$, 'ok');
SELECT pg_temp.t('opA admin cannot attach opB warehouse to opA settings (trigger guard)', 'authenticated', '00000000-0000-0000-0000-0000000000c1',
  $q$INSERT INTO member_warehouse_settings (operator_id, warehouse_id) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2')$q$, 'P0001');
SELECT pg_temp.t('opB admin creates settings with bad slot_minutes (check)', 'authenticated', '00000000-0000-0000-0000-0000000000c4',
  $q$INSERT INTO member_warehouse_settings (operator_id, warehouse_id, slot_minutes) VALUES ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', 0)$q$, '23514');
SELECT pg_temp.t('opA manager updates own warehouse settings', 'authenticated', '00000000-0000-0000-0000-0000000000c2',
  $q$UPDATE member_warehouse_settings SET inspections_per_day = 12 WHERE operator_id = '00000000-0000-0000-0000-0000000000a1'$q$, 'ok');
-- Same RLS-filter-not-error reasoning as the operator_pro_plans picker case above.
SELECT pg_temp.t('opA picker cannot write warehouse settings (write silently filtered)', 'authenticated', '00000000-0000-0000-0000-0000000000c3',
  $q$DO $z$ BEGIN
    UPDATE member_warehouse_settings SET inspections_per_day = 99 WHERE operator_id = '00000000-0000-0000-0000-0000000000a1';
    IF (SELECT inspections_per_day FROM member_warehouse_settings WHERE operator_id = '00000000-0000-0000-0000-0000000000a1') = 99 THEN
      RAISE EXCEPTION 'picker was able to write inspections_per_day';
    END IF;
  END $z$$q$, 'ok');
SELECT pg_temp.t('opB admin cannot see opA warehouse settings (no leak)', 'authenticated', '00000000-0000-0000-0000-0000000000c4',
  $q$DO $z$ BEGIN IF EXISTS (SELECT 1 FROM member_warehouse_settings WHERE operator_id = '00000000-0000-0000-0000-0000000000a1') THEN RAISE EXCEPTION 'leak'; END IF; END $z$$q$, 'ok');
SELECT pg_temp.t('bidder cannot read warehouse settings at all', 'authenticated', '00000000-0000-0000-0000-0000000000d1',
  $q$DO $z$ BEGIN IF EXISTS (SELECT 1 FROM member_warehouse_settings) THEN RAISE EXCEPTION 'leak'; END IF; END $z$$q$, 'ok');
SELECT pg_temp.t('anon cannot read warehouse settings', 'anon', NULL,
  $q$DO $z$ BEGIN IF EXISTS (SELECT 1 FROM member_warehouse_settings) THEN RAISE EXCEPTION 'leak'; END IF; END $z$$q$, 'ok');

-- =========================================================================
-- 3. member_waitlist
-- =========================================================================
SELECT pg_temp.t('opA admin waitlists bidder1', 'authenticated', '00000000-0000-0000-0000-0000000000c1',
  $q$INSERT INTO member_waitlist (operator_id, bidder_id) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1')$q$, 'ok');
SELECT pg_temp.t('opB admin cannot waitlist a bidder at opA', 'authenticated', '00000000-0000-0000-0000-0000000000c4',
  $q$INSERT INTO member_waitlist (operator_id, bidder_id) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d2')$q$, '42501');
SELECT pg_temp.t('bidder1 reads own waitlist row', 'authenticated', '00000000-0000-0000-0000-0000000000d1',
  $q$DO $z$ BEGIN IF (SELECT count(*) FROM member_waitlist WHERE bidder_id = '00000000-0000-0000-0000-0000000000d1') < 1 THEN RAISE EXCEPTION 'expected row'; END IF; END $z$$q$, 'ok');
SELECT pg_temp.t('bidder2 cannot read bidder1 waitlist row (no leak)', 'authenticated', '00000000-0000-0000-0000-0000000000d2',
  $q$DO $z$ BEGIN IF EXISTS (SELECT 1 FROM member_waitlist WHERE bidder_id = '00000000-0000-0000-0000-0000000000d1') THEN RAISE EXCEPTION 'leak'; END IF; END $z$$q$, 'ok');
SELECT pg_temp.t('bidder1 cannot insert their own waitlist row', 'authenticated', '00000000-0000-0000-0000-0000000000d1',
  $q$INSERT INTO member_waitlist (operator_id, bidder_id) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1')$q$, '42501');
SELECT pg_temp.t('anon cannot read waitlist', 'anon', NULL,
  $q$DO $z$ BEGIN IF EXISTS (SELECT 1 FROM member_waitlist) THEN RAISE EXCEPTION 'leak'; END IF; END $z$$q$, 'ok');

-- =========================================================================
-- 4. bidder_subscriptions new columns
-- =========================================================================
SELECT pg_temp.t('square_subscription_id set ok', 'service_role', NULL,
  $q$INSERT INTO bidder_subscriptions (bidder_id, operator_id, square_subscription_id) VALUES ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'sq_sub_1')$q$, 'ok');
SELECT pg_temp.t('dup square_subscription_id rejected', 'service_role', NULL,
  $q$INSERT INTO bidder_subscriptions (bidder_id, operator_id, square_subscription_id) VALUES ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'sq_sub_1')$q$, '23505');
SELECT pg_temp.t('bidder reads own subscription (unchanged 0177 policy)', 'authenticated', '00000000-0000-0000-0000-0000000000d1',
  $q$DO $z$ BEGIN IF (SELECT count(*) FROM bidder_subscriptions WHERE bidder_id = '00000000-0000-0000-0000-0000000000d1') < 1 THEN RAISE EXCEPTION 'expected row'; END IF; END $z$$q$, 'ok');

-- =========================================================================
-- 5. operator_pro_plans: 2026-10-26 additions (staging allowance, large-order
--    fee gate, monthly/active-slot limits)
-- =========================================================================
SELECT pg_temp.t('2026-10-26 defaults on the Pro row', 'service_role', NULL,
  $q$DO $z$ DECLARE r record; BEGIN
    SELECT * INTO r FROM operator_pro_plans WHERE operator_id = '00000000-0000-0000-0000-0000000000a1' AND name = 'Pro';
    IF r.standard_pickup_allowance_qty <> 10 THEN RAISE EXCEPTION 'allowance qty default wrong: %', r.standard_pickup_allowance_qty; END IF;
    IF r.standard_pickup_allowance_unit <> 'items' THEN RAISE EXCEPTION 'allowance unit default wrong: %', r.standard_pickup_allowance_unit; END IF;
    IF r.large_order_slot_minutes <> 60 THEN RAISE EXCEPTION 'large_order_slot_minutes default wrong: %', r.large_order_slot_minutes; END IF;
    IF r.large_order_fee_enabled <> false THEN RAISE EXCEPTION 'large_order_fee_enabled default wrong'; END IF;
    IF r.large_order_fee_cents IS NOT NULL THEN RAISE EXCEPTION 'large_order_fee_cents should default NULL'; END IF;
    IF r.inspections_per_member_month <> 4 THEN RAISE EXCEPTION 'inspections_per_member_month default wrong: %', r.inspections_per_member_month; END IF;
    IF r.max_active_slots_per_member <> 2 THEN RAISE EXCEPTION 'max_active_slots_per_member default wrong: %', r.max_active_slots_per_member; END IF;
  END $z$$q$, 'ok');

SELECT pg_temp.t('standard_pickup_allowance_unit invalid rejected', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, standard_pickup_allowance_unit) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', 'boxes')$q$, '23514');
SELECT pg_temp.t('inspections_per_member_month 0 rejected', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, inspections_per_member_month) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', 0)$q$, '23514');
SELECT pg_temp.t('max_active_slots_per_member over max rejected', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, max_active_slots_per_member) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', 51)$q$, '23514');
SELECT pg_temp.t('large_order_fee_cents 0 rejected (single-column CHECK)', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, large_order_fee_cents) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', 0)$q$, '23514');
SELECT pg_temp.t('large_order_fee_enabled=true with NULL fee rejected (cross-column CHECK)', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, large_order_fee_enabled) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bad', true)$q$, '23514');
SELECT pg_temp.t('large_order_fee_enabled=true WITH a positive fee accepted', 'service_role', NULL,
  $q$INSERT INTO operator_pro_plans (operator_id, name, large_order_fee_enabled, large_order_fee_cents) VALUES ('00000000-0000-0000-0000-0000000000a1', 'FeeOn', true, 2500)$q$, 'ok');
SELECT pg_temp.t('large_order_fee stays off by default ("Fee: off (Michael decides)")', 'service_role', NULL,
  $q$DO $z$ BEGIN IF EXISTS (SELECT 1 FROM operator_pro_plans WHERE operator_id = '00000000-0000-0000-0000-0000000000a1' AND name = 'Pro' AND large_order_fee_enabled) THEN RAISE EXCEPTION 'fee should be off on the default Pro row'; END IF; END $z$$q$, 'ok');

-- =========================================================================
-- 6. member_warehouse_settings: 2026-10-26 additions
-- =========================================================================
SELECT pg_temp.t('large_orders_per_day default 2', 'service_role', NULL,
  $q$DO $z$ BEGIN IF (SELECT large_orders_per_day FROM member_warehouse_settings WHERE operator_id = '00000000-0000-0000-0000-0000000000a1') <> 2 THEN RAISE EXCEPTION 'default wrong'; END IF; END $z$$q$, 'ok');
SELECT pg_temp.t('large_orders_per_day 0 rejected', 'service_role', NULL,
  $q$UPDATE member_warehouse_settings SET large_orders_per_day = 0 WHERE operator_id = '00000000-0000-0000-0000-0000000000a1'$q$, '23514');
SELECT pg_temp.t('allowance override qty/unit nullable, settable together', 'authenticated', '00000000-0000-0000-0000-0000000000c2',
  $q$UPDATE member_warehouse_settings SET standard_pickup_allowance_qty_override = 3, standard_pickup_allowance_unit_override = 'pallets' WHERE operator_id = '00000000-0000-0000-0000-0000000000a1'$q$, 'ok');
SELECT pg_temp.t('allowance override unit invalid rejected', 'service_role', NULL,
  $q$UPDATE member_warehouse_settings SET standard_pickup_allowance_unit_override = 'boxes' WHERE operator_id = '00000000-0000-0000-0000-0000000000a1'$q$, '23514');

-- =========================================================================
-- 7. member_slot_bookings (minimal table -- nothing writes to it yet except
--    these synthetic test rows; cleared before the rollback proof, same as
--    every other table in this rig).
-- =========================================================================
SELECT pg_temp.t('opA admin books a standard slot for bidder1 at opA warehouse', 'authenticated', '00000000-0000-0000-0000-0000000000c1',
  $q$INSERT INTO member_slot_bookings (operator_id, warehouse_id, bidder_id, slot_starts_at) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', now() + interval '2 days')$q$, 'ok');
SELECT pg_temp.t('opA admin cannot attach opB warehouse to an opA booking (trigger guard)', 'authenticated', '00000000-0000-0000-0000-0000000000c1',
  $q$INSERT INTO member_slot_bookings (operator_id, warehouse_id, bidder_id, slot_starts_at) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d1', now() + interval '2 days')$q$, 'P0001');
SELECT pg_temp.t('invalid kind rejected', 'service_role', NULL,
  $q$INSERT INTO member_slot_bookings (operator_id, warehouse_id, bidder_id, slot_starts_at, kind) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', now(), 'rush')$q$, '23514');
SELECT pg_temp.t('invalid status rejected', 'service_role', NULL,
  $q$INSERT INTO member_slot_bookings (operator_id, warehouse_id, bidder_id, slot_starts_at, status) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', now(), 'pending')$q$, '23514');
SELECT pg_temp.t('opA manager updates a booking (e.g. change status)', 'authenticated', '00000000-0000-0000-0000-0000000000c2',
  $q$UPDATE member_slot_bookings SET status = 'changed' WHERE operator_id = '00000000-0000-0000-0000-0000000000a1' AND bidder_id = '00000000-0000-0000-0000-0000000000d1'$q$, 'ok');
SELECT pg_temp.t('opA picker cannot write a booking (write silently filtered)', 'authenticated', '00000000-0000-0000-0000-0000000000c3',
  $q$DO $z$ BEGIN
    UPDATE member_slot_bookings SET status = 'done' WHERE operator_id = '00000000-0000-0000-0000-0000000000a1' AND bidder_id = '00000000-0000-0000-0000-0000000000d1';
    IF (SELECT status FROM member_slot_bookings WHERE operator_id = '00000000-0000-0000-0000-0000000000a1' AND bidder_id = '00000000-0000-0000-0000-0000000000d1') = 'done' THEN
      RAISE EXCEPTION 'picker was able to write status';
    END IF;
  END $z$$q$, 'ok');
SELECT pg_temp.t('opB admin cannot see opA bookings (no leak)', 'authenticated', '00000000-0000-0000-0000-0000000000c4',
  $q$DO $z$ BEGIN IF EXISTS (SELECT 1 FROM member_slot_bookings WHERE operator_id = '00000000-0000-0000-0000-0000000000a1') THEN RAISE EXCEPTION 'leak'; END IF; END $z$$q$, 'ok');
SELECT pg_temp.t('bidder1 reads their own booking', 'authenticated', '00000000-0000-0000-0000-0000000000d1',
  $q$DO $z$ BEGIN IF (SELECT count(*) FROM member_slot_bookings WHERE bidder_id = '00000000-0000-0000-0000-0000000000d1') < 1 THEN RAISE EXCEPTION 'expected row'; END IF; END $z$$q$, 'ok');
SELECT pg_temp.t('bidder2 cannot read bidder1 booking (no leak)', 'authenticated', '00000000-0000-0000-0000-0000000000d2',
  $q$DO $z$ BEGIN IF EXISTS (SELECT 1 FROM member_slot_bookings WHERE bidder_id = '00000000-0000-0000-0000-0000000000d1') THEN RAISE EXCEPTION 'leak'; END IF; END $z$$q$, 'ok');
SELECT pg_temp.t('bidder1 cannot insert their own booking (no bidder write policy)', 'authenticated', '00000000-0000-0000-0000-0000000000d1',
  $q$INSERT INTO member_slot_bookings (operator_id, warehouse_id, bidder_id, slot_starts_at) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', now())$q$, '42501');
SELECT pg_temp.t('anon cannot read bookings', 'anon', NULL,
  $q$DO $z$ BEGIN IF EXISTS (SELECT 1 FROM member_slot_bookings) THEN RAISE EXCEPTION 'leak'; END IF; END $z$$q$, 'ok');

-- =========================================================================
-- 8. member_inspections (minimal table, same deal as member_slot_bookings)
-- =========================================================================
SELECT pg_temp.t('opA admin requests an inspection for bidder1', 'authenticated', '00000000-0000-0000-0000-0000000000c1',
  $q$INSERT INTO member_inspections (operator_id, warehouse_id, bidder_id, requested_for) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', current_date + 1)$q$, 'ok');
SELECT pg_temp.t('opA admin cannot attach opB warehouse to an opA inspection (trigger guard)', 'authenticated', '00000000-0000-0000-0000-0000000000c1',
  $q$INSERT INTO member_inspections (operator_id, warehouse_id, bidder_id, requested_for) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d1', current_date + 1)$q$, 'P0001');
SELECT pg_temp.t('invalid status rejected', 'service_role', NULL,
  $q$INSERT INTO member_inspections (operator_id, warehouse_id, bidder_id, requested_for, status) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', current_date, 'in_progress')$q$, '23514');
SELECT pg_temp.t('status done without done_at rejected (CHECK)', 'service_role', NULL,
  $q$INSERT INTO member_inspections (operator_id, warehouse_id, bidder_id, requested_for, status) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', current_date, 'done')$q$, '23514');
SELECT pg_temp.t('status done WITH done_at accepted', 'service_role', NULL,
  $q$INSERT INTO member_inspections (operator_id, warehouse_id, bidder_id, requested_for, status, done_at, done_by_name) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', current_date, 'done', now(), 'Braden')$q$, 'ok');
SELECT pg_temp.t('opA manager updates an inspection', 'authenticated', '00000000-0000-0000-0000-0000000000c2',
  $q$UPDATE member_inspections SET status = 'scheduled' WHERE operator_id = '00000000-0000-0000-0000-0000000000a1' AND bidder_id = '00000000-0000-0000-0000-0000000000d1' AND status = 'requested'$q$, 'ok');
SELECT pg_temp.t('opA picker cannot write an inspection (write silently filtered)', 'authenticated', '00000000-0000-0000-0000-0000000000c3',
  $q$DO $z$ BEGIN
    UPDATE member_inspections SET status = 'canceled' WHERE operator_id = '00000000-0000-0000-0000-0000000000a1' AND bidder_id = '00000000-0000-0000-0000-0000000000d1' AND status = 'scheduled';
    IF (SELECT count(*) FROM member_inspections WHERE operator_id = '00000000-0000-0000-0000-0000000000a1' AND bidder_id = '00000000-0000-0000-0000-0000000000d1' AND status = 'canceled') > 0 THEN
      RAISE EXCEPTION 'picker was able to cancel an inspection';
    END IF;
  END $z$$q$, 'ok');
SELECT pg_temp.t('opB admin cannot see opA inspections (no leak)', 'authenticated', '00000000-0000-0000-0000-0000000000c4',
  $q$DO $z$ BEGIN IF EXISTS (SELECT 1 FROM member_inspections WHERE operator_id = '00000000-0000-0000-0000-0000000000a1') THEN RAISE EXCEPTION 'leak'; END IF; END $z$$q$, 'ok');
SELECT pg_temp.t('bidder1 reads their own inspections', 'authenticated', '00000000-0000-0000-0000-0000000000d1',
  $q$DO $z$ BEGIN IF (SELECT count(*) FROM member_inspections WHERE bidder_id = '00000000-0000-0000-0000-0000000000d1') < 1 THEN RAISE EXCEPTION 'expected row'; END IF; END $z$$q$, 'ok');
SELECT pg_temp.t('bidder2 cannot read bidder1 inspections (no leak)', 'authenticated', '00000000-0000-0000-0000-0000000000d2',
  $q$DO $z$ BEGIN IF EXISTS (SELECT 1 FROM member_inspections WHERE bidder_id = '00000000-0000-0000-0000-0000000000d1') THEN RAISE EXCEPTION 'leak'; END IF; END $z$$q$, 'ok');
SELECT pg_temp.t('bidder1 cannot insert their own inspection (no bidder write policy)', 'authenticated', '00000000-0000-0000-0000-0000000000d1',
  $q$INSERT INTO member_inspections (operator_id, warehouse_id, bidder_id, requested_for) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', current_date)$q$, '42501');
SELECT pg_temp.t('anon cannot read inspections', 'anon', NULL,
  $q$DO $z$ BEGIN IF EXISTS (SELECT 1 FROM member_inspections) THEN RAISE EXCEPTION 'leak'; END IF; END $z$$q$, 'ok');

SELECT 'all cases done';
