-- ============================================================================
-- Migration 0411 — create the Crandall closeout warehouse (data only)
--
-- Crandall closeout item 1 (docs/state/CRANDALL-CLOSEOUT-SPEC.md). Temporary
-- pickup location for the warehouse closeout auction:
--   119 East Crandall Avenue, Harrison, AR 72601
--
-- Copied from the Harrison row (ce9646af-55b5-412b-bff1-b86a5cdd8b54) so they
-- stay "same as Harrison": operator_id, square_location_id (LH36T6WADKGV7),
-- pickup_mode (counter_pickup). tax_rate_bps stays NULL = inherits the
-- operator's 9.50%, same as Harrison.
--
-- pickup_hours is a PLACEHOLDER (Sat + Sun 09:00–16:00) until Jared sends the
-- real hours; edit in the console (Warehouses → Crandall → Pickup hours).
-- customer_notice and pickup_instructions stay NULL, so no customer screen
-- changes until someone sets the notice. No auction is created here.
--
-- Idempotent: inserts only if no warehouse named 'Crandall' exists for the
-- operator. Prod-only data: where the Harrison row doesn't exist (empty CI
-- database, local dev) it does nothing and says so, like 0403.
--
-- Applied to prod 2026-10-12 from the first version of this file, which
-- RAISEd when Harrison was missing; on prod Harrison exists, so both versions
-- take the same insert path. _schema_migrations keeps that first checksum.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_harrison public.warehouses%ROWTYPE;
BEGIN
  SELECT * INTO v_harrison
    FROM public.warehouses
   WHERE id = 'ce9646af-55b5-412b-bff1-b86a5cdd8b54';
  IF NOT FOUND THEN
    RAISE NOTICE '0411: Harrison warehouse not here, skipping';
    RETURN;
  END IF;

  INSERT INTO public.warehouses (
    operator_id, name,
    address_line1, city, state, postal_code, country, timezone,
    pickup_hours, pickup_mode, square_location_id, tax_rate_bps,
    active, customer_notice, pickup_instructions
  )
  SELECT
    v_harrison.operator_id, 'Crandall',
    '119 East Crandall Avenue', 'Harrison', 'AR', '72601', 'US', 'America/Chicago',
    '{"sat":[{"open":"09:00","close":"16:00"}],"sun":[{"open":"09:00","close":"16:00"}]}'::jsonb,
    v_harrison.pickup_mode, v_harrison.square_location_id, NULL,
    true, NULL, NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM public.warehouses
     WHERE operator_id = v_harrison.operator_id AND name = 'Crandall'
  );
END $$;

COMMIT;
