// 0457: Member Pro PR 1/9 — settings schema only (operator_pro_plans
// extensions, member_warehouse_settings, member_waitlist,
// bidder_subscriptions extensions). File-shape checks only; the behaviour
// proof (apply, re-apply, CHECKs, RLS matrix, rollback) runs on the Docker
// prod copy: scripts/prod-rig/0457-rig/run.sh.
//
// Per the deny-rule on packages/db/migrations for this PR, the real file
// lives at ~/Documents/bingo-migrations-pending/0457_member_pro.sql until the
// owner copies it into packages/db/migrations/. This test reads from the
// normal in-repo path by default, so it fails on purpose (ENOENT) until that
// copy happens -- override MEMBERPRO0457_MIGRATION / MEMBERPRO0457_ROLLBACK
// to point at the pending-file locations for a local check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { readFileSync } from 'node:fs';

const MIG = process.env.MEMBERPRO0457_MIGRATION
  ?? new URL('../../packages/db/migrations/0457_member_pro.sql', import.meta.url).pathname;
const ROLLBACK = process.env.MEMBERPRO0457_ROLLBACK
  ?? new URL('../prod-rig/0457_ROLLBACK_member_pro.sql', import.meta.url).pathname;
const code = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

test('0457 file shape: operator_pro_plans settings columns + widened price_cents', () => {
  const raw = readFileSync(MIG, 'utf8');
  const body = code(raw);

  assert.match(body, /SET LOCAL lock_timeout = '3s';/);
  assert.match(body, /^BEGIN;$/m);
  assert.match(body, /^COMMIT;$/m);

  assert.match(body, /ALTER COLUMN active SET DEFAULT false;/);
  assert.match(body, /ALTER COLUMN price_cents SET DEFAULT 10000;/);
  assert.match(body, /DROP CONSTRAINT IF EXISTS operator_pro_plans_price_cents_check;/);
  assert.match(body, /ADD CONSTRAINT operator_pro_plans_price_cents_check\s+CHECK \(price_cents > 0 AND price_cents <= 100000\);/);

  for (const col of [
    "billing_interval TEXT NOT NULL DEFAULT 'month'",
    'intro_price_cents INTEGER NOT NULL DEFAULT 5000',
    'intro_months INTEGER NOT NULL DEFAULT 6',
    'intro_seats INTEGER NOT NULL DEFAULT 30',
    'member_cap INTEGER NOT NULL DEFAULT 30',
    'past_due_grace_days INTEGER NOT NULL DEFAULT 7',
    'early_access_minutes INTEGER NOT NULL DEFAULT 15',
    'perk_inspection_before_pickup BOOLEAN NOT NULL DEFAULT true',
    'perk_scheduled_pickup_slots BOOLEAN NOT NULL DEFAULT true',
    'perk_early_building_access BOOLEAN NOT NULL DEFAULT true',
    'perk_longer_pickup_window BOOLEAN NOT NULL DEFAULT true',
    'perk_payment_grace BOOLEAN NOT NULL DEFAULT true',
  ]) {
    assert.ok(body.includes(col), `missing column def: ${col}`);
  }
});

test('0457 file shape: operator_pro_plans staging allowance, large-order fee, monthly limits (2026-10-26 additions)', () => {
  const raw = readFileSync(MIG, 'utf8');
  const body = code(raw);

  for (const col of [
    "standard_pickup_allowance_qty INTEGER NOT NULL DEFAULT 10",
    "standard_pickup_allowance_unit TEXT NOT NULL DEFAULT 'items'",
    'large_order_slot_minutes INTEGER NOT NULL DEFAULT 60',
    'large_order_fee_enabled BOOLEAN NOT NULL DEFAULT false',
    'large_order_fee_cents INTEGER',
    'inspections_per_member_month INTEGER NOT NULL DEFAULT 4',
    'max_active_slots_per_member INTEGER NOT NULL DEFAULT 2',
  ]) {
    assert.ok(body.includes(col), `missing column def: ${col}`);
  }

  assert.match(body, /standard_pickup_allowance_unit IN \('items', 'pallets'\)/);
  // Fee amount required once the fee switch is on -- cross-column CHECK.
  assert.match(body, /DROP CONSTRAINT IF EXISTS operator_pro_plans_large_order_fee_check;/);
  assert.match(
    body,
    /ADD CONSTRAINT operator_pro_plans_large_order_fee_check\s+CHECK \(large_order_fee_enabled = false OR \(large_order_fee_cents IS NOT NULL AND large_order_fee_cents > 0\)\);/,
  );
});

test('0457 file shape: member_warehouse_settings gains large_orders_per_day + allowance override columns', () => {
  const raw = readFileSync(MIG, 'utf8');
  const body = code(raw);

  assert.match(body, /large_orders_per_day INTEGER NOT NULL DEFAULT 2/);
  assert.match(body, /standard_pickup_allowance_qty_override INTEGER/);
  assert.match(body, /standard_pickup_allowance_unit_override TEXT/);
  assert.match(
    body,
    /standard_pickup_allowance_unit_override IS NULL\s+OR standard_pickup_allowance_unit_override IN \('items', 'pallets'\)/,
  );
});

for (const table of ['member_slot_bookings', 'member_inspections']) {
  test(`0457 file shape: ${table} minimal table, operator-guard trigger, RLS (staff rw, bidder self-read, no anon)`, () => {
    const raw = readFileSync(MIG, 'utf8');
    const body = code(raw);

    assert.match(body, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(body, new RegExp(`CREATE OR REPLACE FUNCTION ${table}_check_operator\\(\\)`));
    assert.match(body, new RegExp(`DROP TRIGGER IF EXISTS ${table}_operator_guard ON ${table};`));
    assert.match(
      body,
      new RegExp(`BEFORE INSERT OR UPDATE OF operator_id, warehouse_id ON ${table}\\s+FOR EACH ROW EXECUTE FUNCTION ${table}_check_operator\\(\\);`),
    );
    assert.match(body, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`));

    for (const policy of [`${table}_staff_read`, `${table}_staff_insert`, `${table}_staff_update`, `${table}_staff_delete`]) {
      assert.match(body, new RegExp(`DROP POLICY IF EXISTS ${policy} ON ${table};`));
      assert.match(body, new RegExp(`CREATE POLICY ${policy} ON ${table}`));
    }
    assert.match(body, new RegExp(`DROP POLICY IF EXISTS ${table}_bidder_read ON ${table};`));
    assert.match(
      body,
      new RegExp(`CREATE POLICY ${table}_bidder_read ON ${table}\\s+FOR SELECT USING \\(bidder_id = \\(SELECT auth\\.uid\\(\\)\\)\\);`),
    );
    // Write gated to admin/manager; no anon policy anywhere on this table.
    assert.match(body, new RegExp(`${table}_staff_insert[\\s\\S]{0,200}IN \\('admin', 'manager'\\)`));
    assert.doesNotMatch(body, new RegExp(`${table}[\\s\\S]{0,600}\\banon\\b`));
  });
}

test('0457 file shape: member_slot_bookings columns/CHECKs/indexes', () => {
  const raw = readFileSync(MIG, 'utf8');
  const body = code(raw);

  assert.match(body, /slot_starts_at\s+TIMESTAMPTZ NOT NULL/);
  assert.match(body, /kind\s+TEXT NOT NULL DEFAULT 'standard' CHECK \(kind IN \('standard', 'large_order'\)\)/);
  assert.match(body, /status\s+TEXT NOT NULL DEFAULT 'booked' CHECK \(status IN \('booked', 'changed', 'canceled', 'done'\)\)/);
  assert.match(body, /CREATE INDEX IF NOT EXISTS member_slot_bookings_warehouse_day_idx\s+ON member_slot_bookings \(warehouse_id, slot_starts_at\);/);
  assert.match(
    body,
    /CREATE INDEX IF NOT EXISTS member_slot_bookings_bidder_active_idx\s+ON member_slot_bookings \(bidder_id, slot_starts_at\)\s+WHERE status = 'booked';/,
  );
});

test('0457 file shape: member_inspections columns/CHECKs/indexes', () => {
  const raw = readFileSync(MIG, 'utf8');
  const body = code(raw);

  assert.match(body, /requested_for\s+DATE NOT NULL/);
  assert.match(body, /status\s+TEXT NOT NULL DEFAULT 'requested' CHECK \(status IN \('requested', 'scheduled', 'done', 'canceled'\)\)/);
  assert.match(body, /CHECK \(status <> 'done' OR done_at IS NOT NULL\)/);
  assert.match(body, /CREATE INDEX IF NOT EXISTS member_inspections_warehouse_day_idx\s+ON member_inspections \(warehouse_id, requested_for\);/);
  assert.match(
    body,
    /CREATE INDEX IF NOT EXISTS member_inspections_bidder_month_idx\s+ON member_inspections \(bidder_id, requested_for\)\s+WHERE status <> 'canceled';/,
  );
});

test('0457 file shape: member_warehouse_settings table, operator-guard trigger, RLS', () => {
  const raw = readFileSync(MIG, 'utf8');
  const body = code(raw);

  assert.match(body, /CREATE TABLE IF NOT EXISTS member_warehouse_settings/);
  assert.match(body, /UNIQUE \(operator_id, warehouse_id\)/);
  assert.match(body, /CHECK \(staged_orders_per_day > 0 AND staged_orders_per_day <= 500\)/);
  assert.match(body, /CHECK \(slot_minutes > 0 AND slot_minutes <= 240\)/);

  assert.match(body, /CREATE OR REPLACE FUNCTION member_warehouse_settings_check_operator\(\)/);
  assert.match(body, /SECURITY DEFINER/);
  assert.match(body, /RAISE EXCEPTION 'member_warehouse_settings: warehouse % does not belong to operator %'/);
  assert.match(body, /DROP TRIGGER IF EXISTS member_warehouse_settings_operator_guard/);
  assert.match(body, /BEFORE INSERT OR UPDATE OF operator_id, warehouse_id ON member_warehouse_settings/);

  assert.match(body, /ALTER TABLE member_warehouse_settings ENABLE ROW LEVEL SECURITY;/);
  for (const policy of [
    'member_warehouse_settings_staff_read',
    'member_warehouse_settings_staff_insert',
    'member_warehouse_settings_staff_update',
    'member_warehouse_settings_staff_delete',
  ]) {
    assert.match(body, new RegExp(`DROP POLICY IF EXISTS ${policy} ON member_warehouse_settings;`));
    assert.match(body, new RegExp(`CREATE POLICY ${policy} ON member_warehouse_settings`));
  }
  // write policies gated to admin/manager; no bidder/anon policy on this table at all.
  assert.match(body, /member_warehouse_settings_staff_insert[\s\S]{0,200}IN \('admin', 'manager'\)/);
  assert.doesNotMatch(body, /member_warehouse_settings[\s\S]{0,400}is_bidder/);
});

test('0457 file shape: member_waitlist table + RLS (staff all, bidder self-read only)', () => {
  const raw = readFileSync(MIG, 'utf8');
  const body = code(raw);

  assert.match(body, /CREATE TABLE IF NOT EXISTS member_waitlist/);
  assert.match(body, /UNIQUE \(operator_id, bidder_id\)/);
  assert.match(body, /ALTER TABLE member_waitlist ENABLE ROW LEVEL SECURITY;/);
  assert.match(body, /DROP POLICY IF EXISTS member_waitlist_staff_all ON member_waitlist;/);
  assert.match(body, /CREATE POLICY member_waitlist_staff_all ON member_waitlist\s+FOR ALL/);
  assert.match(body, /DROP POLICY IF EXISTS member_waitlist_self_read ON member_waitlist;/);
  assert.match(body, /CREATE POLICY member_waitlist_self_read ON member_waitlist\s+FOR SELECT USING \(bidder_id = \(SELECT auth\.uid\(\)\)\);/);
});

test('0457 file shape: bidder_subscriptions gains intro_applied, square_subscription_id, past_due_since', () => {
  const raw = readFileSync(MIG, 'utf8');
  const body = code(raw);

  assert.match(body, /ADD COLUMN IF NOT EXISTS intro_applied BOOLEAN NOT NULL DEFAULT false/);
  assert.match(body, /ADD COLUMN IF NOT EXISTS square_subscription_id TEXT/);
  assert.match(body, /ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ/);
  assert.match(body, /CREATE UNIQUE INDEX IF NOT EXISTS bidder_subscriptions_square_sub_idx\s+ON bidder_subscriptions \(square_subscription_id\)\s+WHERE square_subscription_id IS NOT NULL;/);
  // No new subscription_status enum value -- 0008's active/past_due/canceled/trialing/none already covers it.
  assert.doesNotMatch(body, /ALTER TYPE subscription_status/);
});

test('0457 no payment code: no Square/Stripe API calls, no DO blocks, guard lint clean', () => {
  const raw = readFileSync(MIG, 'utf8');
  const body = code(raw);

  assert.doesNotMatch(body, /\bDO\s+\$/i, 'no DO blocks (guard lint / no dynamic EXECUTE)');
  // Square/Stripe appear only in explanatory COMMENTs (e.g. what
  // square_subscription_id is for) -- no actual API call shape anywhere.
  assert.doesNotMatch(body, /https?:\/\/|fetch\(|require\(|createClient\(/i, 'no API call code -- schema only');

  const { lintMigration } = require('../check-new-lot-migrations.cjs');
  const { errors, exempt } = lintMigration(raw);
  assert.deepEqual(errors, [], 'guard lint clean');
  assert.equal(exempt, null, 'no footprint-exempt header needed (this migration never touches lots)');
});

test('0457 rollback drops only what 0457 added, restores 0177 price_cents check + active default', () => {
  const rb = code(readFileSync(ROLLBACK, 'utf8'));
  assert.match(rb, /^SET lock_timeout = '3s';$/m);

  assert.match(rb, /DROP INDEX IF EXISTS public\.bidder_subscriptions_square_sub_idx;/);
  assert.match(rb, /DROP COLUMN IF EXISTS past_due_since/);
  assert.match(rb, /DROP COLUMN IF EXISTS square_subscription_id/);
  assert.match(rb, /DROP COLUMN IF EXISTS intro_applied/);

  assert.match(rb, /DROP TABLE IF EXISTS public\.member_waitlist;/);
  assert.match(rb, /DROP TABLE IF EXISTS public\.member_warehouse_settings;/);
  assert.match(rb, /DROP FUNCTION IF EXISTS public\.member_warehouse_settings_check_operator\(\);/);

  for (const col of [
    'perk_payment_grace', 'perk_longer_pickup_window', 'perk_early_building_access',
    'perk_scheduled_pickup_slots', 'perk_inspection_before_pickup', 'early_access_minutes',
    'past_due_grace_days', 'member_cap', 'intro_seats', 'intro_months', 'intro_price_cents', 'billing_interval',
  ]) {
    assert.match(rb, new RegExp(`DROP COLUMN IF EXISTS ${col}`));
  }
  assert.match(rb, /ALTER COLUMN price_cents DROP DEFAULT;/);
  assert.match(rb, /ALTER COLUMN active SET DEFAULT true;/);
  assert.match(rb, /ADD CONSTRAINT operator_pro_plans_price_cents_check\s+CHECK \(price_cents BETWEEN 99 AND 4999\);/);

  assert.doesNotMatch(rb, /\b(DELETE FROM|TRUNCATE|INSERT INTO|UPDATE public|GRANT|REVOKE)\b/i, 'rollback only drops schema, no data/grant changes');
});

test('0457 rollback also drops the 2026-10-26 additions: allowance/large-order columns + member_slot_bookings/member_inspections', () => {
  const rb = code(readFileSync(ROLLBACK, 'utf8'));

  assert.match(rb, /DROP CONSTRAINT IF EXISTS operator_pro_plans_large_order_fee_check;/);
  for (const col of [
    'max_active_slots_per_member', 'inspections_per_member_month', 'large_order_fee_cents',
    'large_order_fee_enabled', 'large_order_slot_minutes', 'standard_pickup_allowance_unit',
    'standard_pickup_allowance_qty',
  ]) {
    assert.match(rb, new RegExp(`DROP COLUMN IF EXISTS ${col}`));
  }

  for (const col of [
    'large_orders_per_day', 'standard_pickup_allowance_qty_override', 'standard_pickup_allowance_unit_override',
  ]) {
    assert.match(rb, new RegExp(`ALTER TABLE public\\.member_warehouse_settings[\\s\\S]{0,400}DROP COLUMN IF EXISTS ${col}`));
  }

  for (const table of ['member_slot_bookings', 'member_inspections']) {
    assert.match(rb, new RegExp(`DROP TRIGGER IF EXISTS ${table}_set_updated_at ON public\\.${table};`));
    assert.match(rb, new RegExp(`DROP TRIGGER IF EXISTS ${table}_operator_guard ON public\\.${table};`));
    assert.match(rb, new RegExp(`DROP TABLE IF EXISTS public\\.${table};`));
    assert.match(rb, new RegExp(`DROP FUNCTION IF EXISTS public\\.${table}_check_operator\\(\\);`));
  }

  assert.doesNotMatch(rb, /\b(DELETE FROM|TRUNCATE|INSERT INTO|UPDATE public|GRANT|REVOKE)\b/i, 'rollback only drops schema, no data/grant changes');
});
