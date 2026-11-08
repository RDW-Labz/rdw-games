-- migration 0144 — operator-configurable rules (W8 DB part)
--
-- Per docs/state/PLAN-field-mobile-restructure-2026-05-25.md W8:
--   New columns on the operators table (additive, defaults match current
--   hardcoded behavior so no operator notices a change until they edit):
--
--     auto_charge_grace_hours       default 48,  range 1-168
--     auto_flag_disposal_at_strikes default 5,   range 1-50
--     no_show_forfeit_threshold     default 3,   range 1-20
--     pickup_grace_extension_hours  default 0,   range 0-168
--
-- ── Why ───────────────────────────────────────────────────────────────────
-- Today these values are hardcoded across the codebase:
--   - 48h auto-charge grace lives in apps/operator-web/src/lib/cron/auto-
--     charge-drain.ts (graceUntil = now + 48h) and the webhook handler.
--   - "strikes before disposal" doesn't exist yet — W5-DB (mig 0145) needs
--     this column to extend auto_relist_unsold_lots.
--   - no-show forfeit threshold + pickup grace extension are both new
--     levers for the W6 checkout fixes.
--
-- Adding the columns now (additive, defaults locked to current behavior)
-- means W5 and W8-UI can proceed without further schema migration. App
-- code keeps using its hardcoded constants until the corresponding UI/
-- cron updates land — then they read from the column.
--
-- ── Idempotency ───────────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS for each column. DO-block IF NOT EXISTS guard
-- around every CHECK constraint. Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Add the four columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.operators
  ADD COLUMN IF NOT EXISTS auto_charge_grace_hours INTEGER NOT NULL DEFAULT 48;

ALTER TABLE public.operators
  ADD COLUMN IF NOT EXISTS auto_flag_disposal_at_strikes INTEGER NOT NULL DEFAULT 5;

ALTER TABLE public.operators
  ADD COLUMN IF NOT EXISTS no_show_forfeit_threshold INTEGER NOT NULL DEFAULT 3;

ALTER TABLE public.operators
  ADD COLUMN IF NOT EXISTS pickup_grace_extension_hours INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. Bounds CHECKs
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operators_auto_charge_grace_bounds') THEN
    ALTER TABLE public.operators
      ADD CONSTRAINT operators_auto_charge_grace_bounds
      CHECK (auto_charge_grace_hours >= 1 AND auto_charge_grace_hours <= 168);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operators_auto_flag_disposal_bounds') THEN
    ALTER TABLE public.operators
      ADD CONSTRAINT operators_auto_flag_disposal_bounds
      CHECK (auto_flag_disposal_at_strikes >= 1 AND auto_flag_disposal_at_strikes <= 50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operators_no_show_forfeit_bounds') THEN
    ALTER TABLE public.operators
      ADD CONSTRAINT operators_no_show_forfeit_bounds
      CHECK (no_show_forfeit_threshold >= 1 AND no_show_forfeit_threshold <= 20);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operators_pickup_grace_bounds') THEN
    ALTER TABLE public.operators
      ADD CONSTRAINT operators_pickup_grace_bounds
      CHECK (pickup_grace_extension_hours >= 0 AND pickup_grace_extension_hours <= 168);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Column comments
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN public.operators.auto_charge_grace_hours IS
  'Hours of grace given to a bidder after the first failed auto-charge '
  'before the lot auto-relists + a $5 relot fee is applied. Default 48 '
  'mirrors the pre-W8 hardcode in apps/operator-web/src/lib/cron/auto-'
  'charge-drain.ts. App code reads this once W8-UI ships; until then '
  'the hardcode stands and operators see no behavior change.';

COMMENT ON COLUMN public.operators.auto_flag_disposal_at_strikes IS
  'When a lot''s relist_count hits this threshold, the W5-DB cron '
  'extension sets lots.flagged_for_disposal=true so the Worklist tab '
  'surfaces it for staff review. Default 5: an item that''s been '
  'auctioned 5+ times with no buyer is unlikely to ever sell.';

COMMENT ON COLUMN public.operators.no_show_forfeit_threshold IS
  'Number of consecutive no-show pickups a bidder is allowed before '
  'their winning lots are forfeited (W6 P1 wrong-customer detection '
  'flow). Default 3.';

COMMENT ON COLUMN public.operators.pickup_grace_extension_hours IS
  'Additional grace hours beyond the operator''s standard pickup '
  'window before a missed pickup transitions to no-show. Default 0 '
  '(no extension — operator standard window applies). Operator can '
  'extend per-operator for high-touch / VIP markets.';

COMMIT;
