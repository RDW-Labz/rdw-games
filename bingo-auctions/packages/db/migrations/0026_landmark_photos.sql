-- ============================================================================
-- Phase C.1 — Bin landmark photos.
--
-- Each bin gets an optional reference photo: what the bin looks like
-- in situ (the shelf, the pallet, the stack). The bidder pickup map
-- uses these so the experience is "look for THIS shelf" instead of
-- "find bin C-12 on a numbered map." This is the highest-value
-- pickup-experience win in the bin-locator wedge.
--
-- Storage:
--   - new bucket bin-landmarks (private, staff write, bidders read)
--   - path convention: <operator_id>/<warehouse_id>/<bin_id>.jpg
-- ============================================================================

ALTER TABLE bins
  ADD COLUMN IF NOT EXISTS landmark_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS landmark_photo_taken_at TIMESTAMPTZ;

COMMENT ON COLUMN bins.landmark_photo_url IS
  'Public URL of the bin landmark photo (Supabase Storage bin-landmarks bucket). Bidder pickup map renders this so the bidder recognises the physical location instead of just a dot on a map.';

COMMENT ON COLUMN bins.landmark_photo_taken_at IS
  'When the most recent landmark photo was taken. Lets the operator see staleness and prompt staff to re-shoot bins whose layout changed.';

INSERT INTO storage.buckets (id, name, public) VALUES
  ('bin-landmarks', 'bin-landmarks', false)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- bin-landmarks: operator staff (any role) can write/read for their own
-- operator's warehouses. Bidders read because the pickup map shows
-- landmark photos to bidders with a staged bin assignment for that bin.
--
-- Path convention: <operator_id>/<warehouse_id>/<bin_id>.jpg
-- ----------------------------------------------------------------------------

CREATE POLICY "bin-landmarks staff write" ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'bin-landmarks'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
  )
  WITH CHECK (
    bucket_id = 'bin-landmarks'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
  );

-- Bidders can read any bin-landmarks object — same approach as floor-plans.
-- The photo URL is only useful to a bidder who's been assigned to that bin
-- via the pickup flow, and the URLs aren't predictable, so leaking the read
-- policy isn't a real exposure.
CREATE POLICY "bin-landmarks bidder read" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'bin-landmarks' AND is_bidder());
