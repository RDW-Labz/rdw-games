-- migration 0255 — public "where is this item" lookup for lot pages
--
-- Customer request 2026-07-10: bidders walking the warehouse during preview
-- can't find items — the physical location (aisle/bay/bin) is staff-only.
-- Expose it on the customer-facing lot pages so people can walk straight to
-- the shelf, and have it follow the item automatically when staff move it
-- (the lookup reads live tables — no denormalized copy to go stale).
--
-- The operator-web lot page reads with the admin client (SSR) and joins bins
-- directly; this RPC exists for the bidder app, whose client-side reads are
-- RLS-blocked on `bins` and `bin_assignments`.
--
-- Privacy gate: returns a location ONLY while the lot's auction is publicly
-- listed (status 'scheduled' or 'live') — the same visibility the storefront
-- itself uses. Closed/draft/canceled auctions return no row. Only location
-- fields go out (bin code / aisle / bay); nothing about other lots or bins.
--
-- Resolution order mirrors staff "Find lot": the latest staged
-- bin_assignment (item pulled for pickup) wins, else the intake shelf
-- (lots.intake_bin_id).

BEGIN;

CREATE OR REPLACE FUNCTION lot_public_location(p_lot_id UUID)
RETURNS TABLE (bin_code TEXT, aisle TEXT, bay TEXT, kind TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH lot AS (
    SELECT l.id, l.intake_bin_id
    FROM lots l
    JOIN auctions a ON a.id = l.auction_id
    WHERE l.id = p_lot_id
      AND a.status IN ('scheduled', 'live')
  ),
  staged AS (
    SELECT b.code, b.aisle, b.bay
    FROM bin_assignments ba
    JOIN bins b ON b.id = ba.bin_id
    WHERE ba.lot_id = (SELECT id FROM lot)
      AND ba.status = 'staged'
    ORDER BY ba.assigned_at DESC
    LIMIT 1
  ),
  shelf AS (
    SELECT b.code, b.aisle, b.bay
    FROM lot
    JOIN bins b ON b.id = lot.intake_bin_id
  )
  SELECT s.code, s.aisle, s.bay, 'pickup'::text FROM staged s
  UNION ALL
  SELECT sh.code, sh.aisle, sh.bay, 'shelf'::text FROM shelf sh
  WHERE NOT EXISTS (SELECT 1 FROM staged)
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION lot_public_location(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lot_public_location(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION lot_public_location(UUID) TO anon;

COMMENT ON FUNCTION lot_public_location(UUID) IS
  '0255: customer-facing item location (bin code/aisle/bay) for a lot in a '
  'publicly listed auction. kind=pickup (staged for pickup) | shelf (intake '
  'bin). Returns no row for lots whose auction is not scheduled/live.';

COMMIT;
