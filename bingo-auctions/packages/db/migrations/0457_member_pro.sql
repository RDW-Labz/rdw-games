-- ============================================================================
-- Migration 0457 — Member Pro ("Pro plan") settings layer, PR 1/9.
--
-- Owner-approved plan (2026-10-26, Michael). This is the SCHEMA layer for the
-- Member Pro settings console page ONLY. No billing, no Square calls, no
-- customer-facing behavior changes. Every operator_pro_plans row stays
-- active=false — nothing sells, nothing is visible to a bidder, until a later
-- PR wires Square subscriptions and turns a plan on.
--
-- UPDATE (2026-10-26, same day, owner changes relayed by Jared) — added to
-- this same PR 1 rather than a follow-up, since it's still settings + schema,
-- no billing:
--   (5) Standard member pickup allowance (qty + unit 'items'|'pallets',
--       operator default + optional per-warehouse override) and a
--       "large order" classification for anything over the allowance: a
--       configurable slot length (large_order_slot_minutes) and a per-
--       warehouse daily cap (large_orders_per_day). An OPTIONAL staging fee
--       for a large order: large_order_fee_enabled + large_order_fee_cents,
--       off by default — "Fee: off (Michael decides)" in the console; NO
--       charging code anywhere in this PR.
--   (6) inspections_per_member_month (default 4).
--   (7) max_active_slots_per_member (default 2). booking_days_ahead (already
--       in member_warehouse_settings) stays the 7-day booking window.
--   (8) member_cap stays 30 (unchanged from the original plan above).
--   (9) Two NEW minimal tables so a read-only usage view can exist in THIS
--       PR, even though booking/inspection FLOWS are PRs 7 and 8:
--       member_slot_bookings, member_inspections. Empty today (nothing
--       writes to them yet) — the usage view reads them and shows zeros /
--       "No member bookings yet". Only the columns the view (and PRs 7/8,
--       which clearly need these columns) require — no booking logic, no
--       slot-generation table, nothing enforced.
--
-- CONTEXT (existing schema, read before writing this)
-- ----------------------------------------------------------------------------
--   0177_operator_memberships.sql created operator_pro_plans (one row per
--   operator "Pro" plan: name, price_cents, extended_pickup_days,
--   extra_grace_hours, staging_prep, active, RLS) + bidder_subscriptions.plan_id
--   + my_active_pro_plan(). 0182/0183 wired the extended-pickup perk into the
--   no-show cron. Prod today: 0 rows in operator_pro_plans, 0 in
--   bidder_subscriptions (confirmed via inspector before writing this).
--
-- WHAT THIS MIGRATION DOES
-- ----------------------------------------------------------------------------
--   (1) EXTEND operator_pro_plans with the settings the console page needs:
--       billing interval, intro pricing (price/months/seats), member cap, the
--       payment-grace window before perks pause, early-building-access
--       minutes, and 4 NEW perk on/off switches (inspection before pickup,
--       scheduled pickup slots, early building access, longer pickup window).
--       staging_prep (0177) is REUSED as the "staging ahead of arrival" perk
--       switch — no new column for it. extra_grace_hours (0177) gains a
--       sibling on/off switch (perk_payment_grace) so staff can flip the perk
--       off without losing the configured magnitude.
--       price_cents' CHECK/DEFAULT are widened: the approved regular price
--       ($100/mo = 10000 cents) and intro price ($50/mo = 5000 cents) both
--       exceed the 0177 ceiling of $49.99 (4999 cents).
--   (2) NEW TABLE member_warehouse_settings — per-operator, per-warehouse
--       daily capacity (staged orders, inspections) + pickup-slot config
--       (slot length, members per slot, how far ahead bidders can book, the
--       cutoff before a booked slot can't be changed). One row per warehouse;
--       an operator with N warehouses gets N rows, each independently tuned
--       (a 2-bay satellite location legitimately needs a smaller
--       inspections_per_day than the flagship warehouse).
--   (3) NEW TABLE member_waitlist — operator_id + bidder_id placeholder for
--       the "member cap reached" flow (PR §2: member_cap full -> waitlist, no
--       charge). created_at/invited_at only; the invite-and-enroll flow is a
--       later PR.
--   (4) EXTEND bidder_subscriptions with 3 columns later PRs clearly need:
--       intro_applied (did this bidder get the intro price), square_subscription_id
--       (billing PR's FK into Square, mirroring the existing stripe_subscription_id
--       UNIQUE pattern), past_due_since (when the grace clock in
--       past_due_grace_days starts counting). subscription_status (0008) ALREADY
--       has 'active' | 'past_due' | 'canceled' | 'trialing' | 'none' — no new
--       enum value needed. current_period_end already exists (0013).
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO (deferred to later PRs)
-- ----------------------------------------------------------------------------
--   - Daily counters (how many staged/inspected today, how many slots booked)
--     are NOT materialized here — they're computed on read from existing
--     fact tables (pickups, missing_item_checks, etc.) once the booking PR
--     lands. Adding counter tables now with nothing to populate them would be
--     dead weight (PLAN §10 anti-pattern: "don't add tables you don't need
--     yet").
--   - No pickup-slot GENERATION (what slots exist on what day) — PR 7's job.
--     member_slot_bookings (added below) only has somewhere to park a row
--     ONCE a later PR books one; nothing writes to it in this PR. The usage
--     view computes a day's slot CAPACITY from warehouses.pickup_hours (0001)
--     ÷ slot_minutes — existing data, no new generation table needed for a
--     read-only count.
--   - No inspection SCHEDULING FLOW (who gets booked when) — PR 8's job.
--     member_inspections (added below) is the same "somewhere to park a row"
--     deal.
--   - No RLS bidder-read grant on operator_pro_plans' new columns beyond what
--     0177's existing public_read policy already allows (gated on active=true
--     + is_bidder()) — plans stay inactive in this PR, so nothing new is
--     bidder-visible in practice. member_warehouse_settings has NO bidder/anon
--     policy at all (internal capacity planning, no bidder-facing use yet).
--     member_waitlist gets a bidder self-read (their own waitlist standing is
--     reasonable to show later) but no bidder write. member_slot_bookings and
--     member_inspections DO get a bidder self-read (a member should be able to
--     see their own upcoming slot / inspection once PRs 7/8 start writing
--     rows) but no bidder write — only staff (admin/manager) books/schedules.
--   - No Square calls, no webhook deltas, no perk-enforcement hooks, no
--     charging code of any kind — large_order_fee_cents is a NUMBER the
--     console persists, never charged. Settings the console writes here are
--     inert until later PRs read them.
--
-- LOCKS / WINDOW
-- ----------------------------------------------------------------------------
--   operator_pro_plans: 0 rows in prod. bidder_subscriptions: 0 rows in prod.
--   Both ALTER TABLE ... ADD COLUMN statements use constant defaults (PG11+
--   fast path, no table rewrite) and the table is empty regardless. The
--   price_cents constraint swap (DROP + ADD CHECK) validates against 0 rows
--   -> instant. member_warehouse_settings / member_waitlist are brand-new
--   tables (no lock on anything existing). Net: this migration takes only
--   SHARE UPDATE EXCLUSIVE-class locks for a few milliseconds on two
--   currently-empty tables. Safe at any hour; no Rule-9 window needed. Applies
--   only when no sq-ft step (0451-series) is in flight, per the owner's
--   standing instruction to serialize migration applies.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, guarded
-- constraint drops. Safe to re-run. SET LOCAL lock_timeout so a stuck apply
-- fails fast instead of queuing behind something else.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ----------------------------------------------------------------------------
-- (1) EXTEND operator_pro_plans — plan-level Member Pro settings
-- ----------------------------------------------------------------------------

-- active: 0177 defaulted this to true. The approved plan requires every plan
-- to START OFF -- flip the DEFAULT to false so a future direct insert that
-- forgets to set it explicitly still lands off, not just the console path
-- (which also always inserts active:false; this is belt-and-suspenders).
ALTER TABLE operator_pro_plans
  ALTER COLUMN active SET DEFAULT false;

-- price_cents: widen for the approved $100/mo regular price. 0177's ceiling
-- (4999 = $49.99) and its lack of a DEFAULT both predate Member Pro's pricing.
ALTER TABLE operator_pro_plans
  ALTER COLUMN price_cents SET DEFAULT 10000;

ALTER TABLE operator_pro_plans
  DROP CONSTRAINT IF EXISTS operator_pro_plans_price_cents_check;

ALTER TABLE operator_pro_plans
  ADD CONSTRAINT operator_pro_plans_price_cents_check
  CHECK (price_cents > 0 AND price_cents <= 100000);  -- up to $1000/mo ceiling

ALTER TABLE operator_pro_plans
  ADD COLUMN IF NOT EXISTS billing_interval TEXT NOT NULL DEFAULT 'month'
    CHECK (billing_interval IN ('month', 'year')),
  ADD COLUMN IF NOT EXISTS intro_price_cents INTEGER NOT NULL DEFAULT 5000
    CHECK (intro_price_cents > 0 AND intro_price_cents <= 100000),
  ADD COLUMN IF NOT EXISTS intro_months INTEGER NOT NULL DEFAULT 6
    CHECK (intro_months > 0 AND intro_months <= 24),
  ADD COLUMN IF NOT EXISTS intro_seats INTEGER NOT NULL DEFAULT 30
    CHECK (intro_seats >= 0 AND intro_seats <= 1000),
  ADD COLUMN IF NOT EXISTS member_cap INTEGER NOT NULL DEFAULT 30
    CHECK (member_cap > 0 AND member_cap <= 5000),
  ADD COLUMN IF NOT EXISTS past_due_grace_days INTEGER NOT NULL DEFAULT 7
    CHECK (past_due_grace_days >= 0 AND past_due_grace_days <= 60),
  ADD COLUMN IF NOT EXISTS early_access_minutes INTEGER NOT NULL DEFAULT 15
    CHECK (early_access_minutes >= 0 AND early_access_minutes <= 240),
  ADD COLUMN IF NOT EXISTS perk_inspection_before_pickup BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS perk_scheduled_pickup_slots BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS perk_early_building_access BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS perk_longer_pickup_window BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS perk_payment_grace BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN operator_pro_plans.billing_interval IS
  'mig 0457: Square billing cadence for this plan. Console setting; no Square '
  'call reads/writes this yet (billing PR).';
COMMENT ON COLUMN operator_pro_plans.intro_price_cents IS
  'mig 0457: introductory monthly price (approved default $50.00) for the '
  'first intro_seats members, for intro_months months, then price_cents.';
COMMENT ON COLUMN operator_pro_plans.intro_months IS
  'mig 0457: how many months a member keeps intro_price_cents before rolling '
  'to price_cents. Default 6.';
COMMENT ON COLUMN operator_pro_plans.intro_seats IS
  'mig 0457: how many of the FIRST members to sign up get the intro price. '
  'Default 30 (approved: "intro $50/month for the first 30 members"). 0 '
  'means no intro pricing is offered.';
COMMENT ON COLUMN operator_pro_plans.member_cap IS
  'mig 0457: max concurrent active members. When full, new signups land in '
  'member_waitlist instead of being charged (enforced by a later PR).';
COMMENT ON COLUMN operator_pro_plans.past_due_grace_days IS
  'mig 0457: days a member stays past_due before perks pause. Enforcement is '
  'a later PR (the billing PR reads this alongside bidder_subscriptions.'
  'past_due_since).';
COMMENT ON COLUMN operator_pro_plans.early_access_minutes IS
  'mig 0457: minutes of early building access before public opening, display '
  'only per the approved plan ("early building access (15 min, display '
  'only)") -- no enforcement/gate in this PR.';
COMMENT ON COLUMN operator_pro_plans.perk_inspection_before_pickup IS
  'mig 0457: on/off switch for the "item inspection before pickup" perk. No '
  'enforcement hook yet -- this PR only persists the switch.';
COMMENT ON COLUMN operator_pro_plans.perk_scheduled_pickup_slots IS
  'mig 0457: on/off switch for the "scheduled pickup slots (members only)" '
  'perk. Slot booking itself is a later PR; member_warehouse_settings (this '
  'migration) only persists the slot CONFIGURATION.';
COMMENT ON COLUMN operator_pro_plans.perk_early_building_access IS
  'mig 0457: on/off switch for the early-building-access perk '
  '(early_access_minutes). Display-only per the approved plan.';
COMMENT ON COLUMN operator_pro_plans.perk_longer_pickup_window IS
  'mig 0457: on/off switch wrapping the EXISTING extended_pickup_days (0177) '
  'so staff can disable the perk without losing the configured day count.';
COMMENT ON COLUMN operator_pro_plans.perk_payment_grace IS
  'mig 0457: on/off switch wrapping the EXISTING extra_grace_hours (0177), '
  'same reasoning as perk_longer_pickup_window.';
COMMENT ON COLUMN operator_pro_plans.staging_prep IS
  '0177, REPURPOSED by mig 0457 as the "staging ahead of arrival" perk '
  'on/off switch (member-only auctions were dropped from the approved plan; '
  'staging ahead of arrival is the perk this column now represents). No '
  'column rename to avoid unnecessary churn on a 0-row table.';

-- ----------------------------------------------------------------------------
-- (2) NEW: member_warehouse_settings — per-operator, per-warehouse capacity
--     + pickup-slot configuration.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_warehouse_settings (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id            UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  warehouse_id           UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  staged_orders_per_day  INTEGER NOT NULL DEFAULT 15 CHECK (staged_orders_per_day > 0 AND staged_orders_per_day <= 500),
  inspections_per_day    INTEGER NOT NULL DEFAULT 10 CHECK (inspections_per_day > 0 AND inspections_per_day <= 500),
  slot_minutes           INTEGER NOT NULL DEFAULT 30 CHECK (slot_minutes > 0 AND slot_minutes <= 240),
  members_per_slot       INTEGER NOT NULL DEFAULT 3  CHECK (members_per_slot > 0 AND members_per_slot <= 50),
  booking_days_ahead     INTEGER NOT NULL DEFAULT 7  CHECK (booking_days_ahead > 0 AND booking_days_ahead <= 90),
  change_cutoff_hours    INTEGER NOT NULL DEFAULT 2  CHECK (change_cutoff_hours >= 0 AND change_cutoff_hours <= 168),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operator_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS member_warehouse_settings_operator_idx
  ON member_warehouse_settings (operator_id);

COMMENT ON TABLE member_warehouse_settings IS
  'mig 0457: per-warehouse Member Pro capacity + pickup-slot configuration. '
  'One row per warehouse (an operator with multiple warehouses tunes each '
  'independently -- a small satellite location legitimately needs lower '
  'daily limits than the flagship warehouse). Daily USAGE counters are '
  'computed on read from existing fact tables in a later PR, not stored '
  'here.';

-- Guard: operator_id must actually own warehouse_id. Cheap trigger (settings
-- table, not a hot path) rather than a composite FK, since warehouses has no
-- (id, operator_id) unique constraint to hang one off of.
CREATE OR REPLACE FUNCTION member_warehouse_settings_check_operator()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM warehouses w
    WHERE w.id = NEW.warehouse_id AND w.operator_id = NEW.operator_id
  ) THEN
    RAISE EXCEPTION 'member_warehouse_settings: warehouse % does not belong to operator %',
      NEW.warehouse_id, NEW.operator_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_warehouse_settings_operator_guard ON member_warehouse_settings;
CREATE TRIGGER member_warehouse_settings_operator_guard
  BEFORE INSERT OR UPDATE OF operator_id, warehouse_id ON member_warehouse_settings
  FOR EACH ROW EXECUTE FUNCTION member_warehouse_settings_check_operator();

DROP TRIGGER IF EXISTS member_warehouse_settings_set_updated_at ON member_warehouse_settings;
CREATE TRIGGER member_warehouse_settings_set_updated_at
  BEFORE UPDATE ON member_warehouse_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE member_warehouse_settings ENABLE ROW LEVEL SECURITY;

-- Staff (admin/manager) of the operator may read/write. No bidder/anon
-- policy at all -- internal capacity planning, nothing customer-facing reads
-- this in this PR.
DROP POLICY IF EXISTS member_warehouse_settings_staff_read ON member_warehouse_settings;
CREATE POLICY member_warehouse_settings_staff_read ON member_warehouse_settings
  FOR SELECT USING (operator_id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS member_warehouse_settings_staff_insert ON member_warehouse_settings;
CREATE POLICY member_warehouse_settings_staff_insert ON member_warehouse_settings
  FOR INSERT WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS member_warehouse_settings_staff_update ON member_warehouse_settings;
CREATE POLICY member_warehouse_settings_staff_update ON member_warehouse_settings
  FOR UPDATE USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS member_warehouse_settings_staff_delete ON member_warehouse_settings;
CREATE POLICY member_warehouse_settings_staff_delete ON member_warehouse_settings
  FOR DELETE USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) = 'admin'
  );

-- ----------------------------------------------------------------------------
-- (3) NEW: member_waitlist — bidders who signed up while member_cap was full.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_waitlist (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id  UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  bidder_id    UUID NOT NULL REFERENCES bidders(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  invited_at   TIMESTAMPTZ,
  UNIQUE (operator_id, bidder_id)
);

CREATE INDEX IF NOT EXISTS member_waitlist_operator_created_idx
  ON member_waitlist (operator_id, created_at)
  WHERE invited_at IS NULL;

COMMENT ON TABLE member_waitlist IS
  'mig 0457: a bidder who tried to join Member Pro while member_cap was full. '
  'No charge happens for a waitlisted bidder. The invite-when-a-seat-opens '
  'flow (populating invited_at, prompting the bidder to subscribe) is a '
  'later PR -- this PR only has somewhere to park the row.';

ALTER TABLE member_waitlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS member_waitlist_staff_all ON member_waitlist;
CREATE POLICY member_waitlist_staff_all ON member_waitlist
  FOR ALL USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

-- A bidder may see their own waitlist standing (their "member row").
DROP POLICY IF EXISTS member_waitlist_self_read ON member_waitlist;
CREATE POLICY member_waitlist_self_read ON member_waitlist
  FOR SELECT USING (bidder_id = (SELECT auth.uid()));

-- ----------------------------------------------------------------------------
-- (4) EXTEND bidder_subscriptions — columns later PRs clearly need.
-- ----------------------------------------------------------------------------
ALTER TABLE bidder_subscriptions
  ADD COLUMN IF NOT EXISTS intro_applied BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS square_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS bidder_subscriptions_square_sub_idx
  ON bidder_subscriptions (square_subscription_id)
  WHERE square_subscription_id IS NOT NULL;

COMMENT ON COLUMN bidder_subscriptions.intro_applied IS
  'mig 0457: true once this subscription has consumed one of plan.intro_seats '
  'at plan.intro_price_cents. Written by the billing PR, not this one.';
COMMENT ON COLUMN bidder_subscriptions.square_subscription_id IS
  'mig 0457: Square subscription id (billing runs on Square per '
  'apps/operator-web/src/lib/square.ts -- NOT Stripe; the legacy '
  'stripe_subscription_id column on this table predates the Square cutover '
  'and is untouched here). UNIQUE like its Stripe sibling. NULL until the '
  'billing PR creates the Square subscription.';
COMMENT ON COLUMN bidder_subscriptions.past_due_since IS
  'mig 0457: when this subscription first went past_due. The billing PR '
  'compares now() - past_due_since against plan.past_due_grace_days to decide '
  'whether perks are still active for a past_due member.';

-- ----------------------------------------------------------------------------
-- (5) EXTEND operator_pro_plans — standard pickup allowance, large-order
--     classification + optional fee, monthly inspection allowance, max active
--     slots per member. Owner changes relayed by Jared, 2026-10-26.
-- ----------------------------------------------------------------------------
ALTER TABLE operator_pro_plans
  ADD COLUMN IF NOT EXISTS standard_pickup_allowance_qty INTEGER NOT NULL DEFAULT 10
    CHECK (standard_pickup_allowance_qty > 0 AND standard_pickup_allowance_qty <= 10000),
  ADD COLUMN IF NOT EXISTS standard_pickup_allowance_unit TEXT NOT NULL DEFAULT 'items'
    CHECK (standard_pickup_allowance_unit IN ('items', 'pallets')),
  ADD COLUMN IF NOT EXISTS large_order_slot_minutes INTEGER NOT NULL DEFAULT 60
    CHECK (large_order_slot_minutes > 0 AND large_order_slot_minutes <= 480),
  ADD COLUMN IF NOT EXISTS large_order_fee_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS large_order_fee_cents INTEGER
    CHECK (large_order_fee_cents IS NULL OR large_order_fee_cents > 0),
  ADD COLUMN IF NOT EXISTS inspections_per_member_month INTEGER NOT NULL DEFAULT 4
    CHECK (inspections_per_member_month > 0 AND inspections_per_member_month <= 100),
  ADD COLUMN IF NOT EXISTS max_active_slots_per_member INTEGER NOT NULL DEFAULT 2
    CHECK (max_active_slots_per_member > 0 AND max_active_slots_per_member <= 50);

-- Cross-column CHECK (fee amount required once the fee is turned on) needs a
-- separate ADD CONSTRAINT -- same DROP-then-ADD idempotency pattern as the
-- price_cents constraint swap above.
--
-- MUST test `large_order_fee_cents IS NOT NULL` explicitly, not just
-- `> 0` -- a bare `large_order_fee_cents > 0` evaluates to NULL (not FALSE)
-- when the column IS NULL, and Postgres CHECK constraints only reject a row
-- on an explicit FALSE (NULL is treated as "not violated"). Without the
-- IS NOT NULL test, `large_order_fee_enabled = true` with a NULL
-- large_order_fee_cents would pass this CHECK -- caught by the 0457-rig RLS/
-- constraint matrix before this shipped (scripts/prod-rig/0457-rig/cases.sql).
ALTER TABLE operator_pro_plans
  DROP CONSTRAINT IF EXISTS operator_pro_plans_large_order_fee_check;
ALTER TABLE operator_pro_plans
  ADD CONSTRAINT operator_pro_plans_large_order_fee_check
  CHECK (large_order_fee_enabled = false OR (large_order_fee_cents IS NOT NULL AND large_order_fee_cents > 0));

COMMENT ON COLUMN operator_pro_plans.standard_pickup_allowance_qty IS
  'mig 0457: how many items (or pallets, per the unit column) a standard '
  'member pickup may include before it is classified a "large order". '
  'Default 10 items -- a sensible small-order ceiling for a single staff '
  'staging slot; operators tune it per their own volume. Overridable per '
  'warehouse via member_warehouse_settings.standard_pickup_allowance_*_override.';
COMMENT ON COLUMN operator_pro_plans.standard_pickup_allowance_unit IS
  'mig 0457: the unit standard_pickup_allowance_qty is counted in. Default '
  '''items'' -- ''pallets'' is for an operator whose typical order is '
  'palletized freight, not individual items.';
COMMENT ON COLUMN operator_pro_plans.large_order_slot_minutes IS
  'mig 0457: length of a "large order" staging slot (an order over the '
  'standard pickup allowance books a SEPARATE slot of this length). Default '
  '60 -- a large order plausibly needs real staff time to stage, longer than '
  'a standard member_warehouse_settings.slot_minutes slot (default 30).';
COMMENT ON COLUMN operator_pro_plans.large_order_fee_enabled IS
  'mig 0457: on/off switch for an OPTIONAL staging fee on a large order. '
  'Default false ("Fee: off (Michael decides)" in the console) -- no '
  'charging code anywhere in this PR; a later billing PR would be the first '
  'thing that could ever actually charge large_order_fee_cents.';
COMMENT ON COLUMN operator_pro_plans.large_order_fee_cents IS
  'mig 0457: the large-order staging fee amount, in cents. NULL while the '
  'fee is off; the operator_pro_plans_large_order_fee_check constraint '
  'requires a positive value the moment large_order_fee_enabled flips true. '
  'Not charged by anything in this PR.';
COMMENT ON COLUMN operator_pro_plans.inspections_per_member_month IS
  'mig 0457: how many item inspections a member gets per calendar month '
  '(America/Chicago). Default 4. Enforcement (counting member_inspections '
  'rows against this) is in packages/shared/src/member-pro.ts for a later '
  'PR to call; this PR only persists the allowance + exposes it to the '
  'read-only usage view.';
COMMENT ON COLUMN operator_pro_plans.max_active_slots_per_member IS
  'mig 0457: max concurrent FUTURE ''booked'' rows a member may hold across '
  'member_slot_bookings at once (standard + large_order kinds combined). '
  'Default 2. The 7-day booking window is the existing '
  'member_warehouse_settings.booking_days_ahead -- unchanged by this PR.';

-- ----------------------------------------------------------------------------
-- (6) EXTEND member_warehouse_settings — large-order daily cap + optional
--     per-warehouse override of the operator-level pickup allowance.
-- ----------------------------------------------------------------------------
ALTER TABLE member_warehouse_settings
  ADD COLUMN IF NOT EXISTS large_orders_per_day INTEGER NOT NULL DEFAULT 2
    CHECK (large_orders_per_day > 0 AND large_orders_per_day <= 100),
  ADD COLUMN IF NOT EXISTS standard_pickup_allowance_qty_override INTEGER
    CHECK (standard_pickup_allowance_qty_override IS NULL OR standard_pickup_allowance_qty_override > 0),
  ADD COLUMN IF NOT EXISTS standard_pickup_allowance_unit_override TEXT
    CHECK (
      standard_pickup_allowance_unit_override IS NULL
      OR standard_pickup_allowance_unit_override IN ('items', 'pallets')
    );

COMMENT ON COLUMN member_warehouse_settings.large_orders_per_day IS
  'mig 0457: max large-order staging slots this warehouse can run per day. '
  'Default 2 (a 2-bay satellite location legitimately handles fewer large '
  'orders/day than the flagship warehouse, same reasoning as '
  'staged_orders_per_day / inspections_per_day above).';
COMMENT ON COLUMN member_warehouse_settings.standard_pickup_allowance_qty_override IS
  'mig 0457: per-warehouse override of operator_pro_plans.'
  'standard_pickup_allowance_qty. NULL (the common case) means "use the '
  'operator default" -- set only for a warehouse whose staging capacity '
  'genuinely differs.';
COMMENT ON COLUMN member_warehouse_settings.standard_pickup_allowance_unit_override IS
  'mig 0457: per-warehouse override of operator_pro_plans.'
  'standard_pickup_allowance_unit. NULL means "use the operator default". '
  'Set together with the qty override (both NULL or both set is the '
  'expected console usage, enforced client-side, not by a DB constraint -- '
  'a lone override of one field without the other is harmless, just unusual).';

-- ----------------------------------------------------------------------------
-- (7) NEW TABLE member_slot_bookings — minimal shape so the read-only usage
--     view (below, in the console) has something to read. Booking FLOW
--     (creating/changing/canceling a row from the bidder app) is PR 7; this
--     PR writes no rows, enforces no limits, just persists the shape.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_slot_bookings (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id    UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  warehouse_id   UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  bidder_id      UUID NOT NULL REFERENCES bidders(id) ON DELETE CASCADE,
  invoice_id     UUID REFERENCES invoices(id) ON DELETE SET NULL,
  slot_starts_at TIMESTAMPTZ NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'large_order')),
  status         TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'changed', 'canceled', 'done')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-day counting (the usage view groups by warehouse + calendar day) and
-- "how many ACTIVE slots does this member hold right now" (max_active_slots_
-- per_member, future booked rows only -- see packages/shared/src/
-- member-pro.ts activeBookedSlotCount).
CREATE INDEX IF NOT EXISTS member_slot_bookings_warehouse_day_idx
  ON member_slot_bookings (warehouse_id, slot_starts_at);
CREATE INDEX IF NOT EXISTS member_slot_bookings_bidder_active_idx
  ON member_slot_bookings (bidder_id, slot_starts_at)
  WHERE status = 'booked';
CREATE INDEX IF NOT EXISTS member_slot_bookings_operator_kind_day_idx
  ON member_slot_bookings (operator_id, warehouse_id, kind, slot_starts_at);

COMMENT ON TABLE member_slot_bookings IS
  'mig 0457: a member''s booked (or changed/canceled/done) pickup slot. '
  'EMPTY in this PR -- nothing writes a row yet (PR 7 is the booking flow). '
  'The read-only usage view counts these per warehouse per day; '
  'max_active_slots_per_member counts future ''booked'' rows per bidder.';

CREATE OR REPLACE FUNCTION member_slot_bookings_check_operator()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM warehouses w
    WHERE w.id = NEW.warehouse_id AND w.operator_id = NEW.operator_id
  ) THEN
    RAISE EXCEPTION 'member_slot_bookings: warehouse % does not belong to operator %',
      NEW.warehouse_id, NEW.operator_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_slot_bookings_operator_guard ON member_slot_bookings;
CREATE TRIGGER member_slot_bookings_operator_guard
  BEFORE INSERT OR UPDATE OF operator_id, warehouse_id ON member_slot_bookings
  FOR EACH ROW EXECUTE FUNCTION member_slot_bookings_check_operator();

DROP TRIGGER IF EXISTS member_slot_bookings_set_updated_at ON member_slot_bookings;
CREATE TRIGGER member_slot_bookings_set_updated_at
  BEFORE UPDATE ON member_slot_bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE member_slot_bookings ENABLE ROW LEVEL SECURITY;

-- Staff (admin/manager) of the operator read/write. A bidder may read (not
-- write -- only staff books/changes/cancels in this PR's RLS shape; PR 7
-- decides whether a bidder-initiated booking writes via service-role or gets
-- its own INSERT policy) their OWN rows only. No anon policy.
DROP POLICY IF EXISTS member_slot_bookings_staff_read ON member_slot_bookings;
CREATE POLICY member_slot_bookings_staff_read ON member_slot_bookings
  FOR SELECT USING (operator_id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS member_slot_bookings_staff_insert ON member_slot_bookings;
CREATE POLICY member_slot_bookings_staff_insert ON member_slot_bookings
  FOR INSERT WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS member_slot_bookings_staff_update ON member_slot_bookings;
CREATE POLICY member_slot_bookings_staff_update ON member_slot_bookings
  FOR UPDATE USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS member_slot_bookings_staff_delete ON member_slot_bookings;
CREATE POLICY member_slot_bookings_staff_delete ON member_slot_bookings
  FOR DELETE USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) = 'admin'
  );

DROP POLICY IF EXISTS member_slot_bookings_bidder_read ON member_slot_bookings;
CREATE POLICY member_slot_bookings_bidder_read ON member_slot_bookings
  FOR SELECT USING (bidder_id = (SELECT auth.uid()));

-- ----------------------------------------------------------------------------
-- (8) NEW TABLE member_inspections — same "minimal shape for the usage view,
--     no flow" deal as member_slot_bookings. PR 8 is the inspection-
--     scheduling flow.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_inspections (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id   UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  warehouse_id  UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  bidder_id     UUID NOT NULL REFERENCES bidders(id) ON DELETE CASCADE,
  invoice_id    UUID REFERENCES invoices(id) ON DELETE SET NULL,
  lot_id        UUID REFERENCES lots(id) ON DELETE SET NULL,
  requested_for DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'scheduled', 'done', 'canceled')),
  done_by_name  TEXT,
  done_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'done' OR done_at IS NOT NULL)
);

-- Per-day counting (usage view) and per-member-per-month counting
-- (inspections_per_member_month -- excludes canceled rows, see
-- packages/shared/src/member-pro.ts inspectionsUsedThisMonth).
CREATE INDEX IF NOT EXISTS member_inspections_warehouse_day_idx
  ON member_inspections (warehouse_id, requested_for);
CREATE INDEX IF NOT EXISTS member_inspections_bidder_month_idx
  ON member_inspections (bidder_id, requested_for)
  WHERE status <> 'canceled';

COMMENT ON TABLE member_inspections IS
  'mig 0457: a member''s requested (or scheduled/done/canceled) item '
  'inspection. EMPTY in this PR -- PR 8 is the scheduling flow. '
  'done_by_name mirrors the typed-staff-name convention used elsewhere in '
  'this migration''s console (BinGo staff share logins; auth.uid() alone '
  'doesn''t say who physically did the inspection).';

CREATE OR REPLACE FUNCTION member_inspections_check_operator()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM warehouses w
    WHERE w.id = NEW.warehouse_id AND w.operator_id = NEW.operator_id
  ) THEN
    RAISE EXCEPTION 'member_inspections: warehouse % does not belong to operator %',
      NEW.warehouse_id, NEW.operator_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_inspections_operator_guard ON member_inspections;
CREATE TRIGGER member_inspections_operator_guard
  BEFORE INSERT OR UPDATE OF operator_id, warehouse_id ON member_inspections
  FOR EACH ROW EXECUTE FUNCTION member_inspections_check_operator();

DROP TRIGGER IF EXISTS member_inspections_set_updated_at ON member_inspections;
CREATE TRIGGER member_inspections_set_updated_at
  BEFORE UPDATE ON member_inspections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE member_inspections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS member_inspections_staff_read ON member_inspections;
CREATE POLICY member_inspections_staff_read ON member_inspections
  FOR SELECT USING (operator_id = (SELECT current_operator_id()));

DROP POLICY IF EXISTS member_inspections_staff_insert ON member_inspections;
CREATE POLICY member_inspections_staff_insert ON member_inspections
  FOR INSERT WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS member_inspections_staff_update ON member_inspections;
CREATE POLICY member_inspections_staff_update ON member_inspections
  FOR UPDATE USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS member_inspections_staff_delete ON member_inspections;
CREATE POLICY member_inspections_staff_delete ON member_inspections
  FOR DELETE USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) = 'admin'
  );

DROP POLICY IF EXISTS member_inspections_bidder_read ON member_inspections;
CREATE POLICY member_inspections_bidder_read ON member_inspections
  FOR SELECT USING (bidder_id = (SELECT auth.uid()));

COMMIT;
