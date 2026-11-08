-- Isolated fixture ONLY. Run in a newly created disposable database, never in
-- an existing application database. Models only columns read by migration0369;
-- does not certify all production schema constraints/triggers or print paths.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regclass('public.lots') IS NOT NULL THEN
    RAISE EXCEPTION 'physical-footprint fixture requires an empty database';
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE TABLE public.physical_footprint_fixture_marker (fixture boolean PRIMARY KEY CHECK (fixture));
INSERT INTO public.physical_footprint_fixture_marker VALUES (true);
CREATE TABLE public.lots (
  id uuid PRIMARY KEY, operator_id uuid NOT NULL,
  relisted_from_lot_id uuid, sticker_code text, intake_bin_id uuid,
  intake_at timestamptz, deleted_at timestamptz,
  auction_id uuid, winner_bidder_id uuid, bid_count integer DEFAULT 0
);
CREATE TABLE public.bin_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lot_id uuid NOT NULL, bin_id uuid NOT NULL);
CREATE TABLE public.lot_location_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lot_id uuid NOT NULL, bin_id uuid, kind text DEFAULT 'intake');
CREATE TABLE public.lot_sticker_pool (qr_token uuid PRIMARY KEY DEFAULT gen_random_uuid(), claimed_by_lot_id uuid, claimed_at timestamptz);
CREATE INDEX bin_assignments_lot_idx ON public.bin_assignments(lot_id);
CREATE INDEX lot_location_events_lot_idx ON public.lot_location_events(lot_id);
-- 0367 is reserved for PR348, so do not assume it has been deployed.
-- No claim or relist index is added by this focused fixture.
ALTER TABLE public.lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bin_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lot_location_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lot_sticker_pool ENABLE ROW LEVEL SECURITY;
