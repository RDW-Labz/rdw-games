-- ============================================================================
-- Migration 0406 — warehouse active flag + customer-facing copy
--
-- Adds:
--   warehouses.active               — hide from pickers when false; history untouched
--   warehouses.pickup_instructions  — optional staff-edited pickup guidance
--   warehouses.customer_notice      — optional off-site banner for customer apps
--
-- Purely additive: DEFAULT true on active, no backfill, no data migration.
-- ============================================================================

BEGIN;

ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pickup_instructions TEXT,
  ADD COLUMN IF NOT EXISTS customer_notice TEXT;

COMMENT ON COLUMN public.warehouses.active IS
  '0406: When false, warehouse is hidden from auction/lotting/staff-app pickers. '
  'Existing auctions, lots, and pickups are unchanged; nothing is deleted.';

COMMENT ON COLUMN public.warehouses.pickup_instructions IS
  '0406: Optional pickup guidance shown to customers for this warehouse (console-edited). '
  'NULL = no extra instructions.';

COMMENT ON COLUMN public.warehouses.customer_notice IS
  '0406: When set, customer screens treat this warehouse as off-site and show this '
  'text as a banner before bidding. NULL = normal on-site warehouse.';

COMMIT;
