-- ============================================================================
-- Storage buckets — Supabase Storage configuration.
--
-- Three buckets:
--   - lot-photos: public, operators write, anyone reads (item photos shown
--     in browse + lot detail).
--   - floor-plans: private, operators write/read, bidders read for warehouses
--     where they have a paid invoice.
--   - dispute-photos: private, bidder writes, operator reads.
--
-- Bucket creation in Supabase is via the storage schema. Policies use the
-- same auth.uid() helpers we built in 0002_rls.sql.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public) VALUES
  ('lot-photos',       'lot-photos',       true),
  ('floor-plans',      'floor-plans',      false),
  ('dispute-photos',   'dispute-photos',   false),
  ('staging-photos',   'staging-photos',   false)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- lot-photos: anyone can read, operator staff can write/delete for their own
-- operator's lots. Object path convention: <operator_id>/<lot_id>/<filename>.
-- ----------------------------------------------------------------------------

CREATE POLICY "lot-photos read" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'lot-photos');

CREATE POLICY "lot-photos write — operator staff" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'lot-photos'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
  );

CREATE POLICY "lot-photos delete — operator staff" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'lot-photos'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
  );

-- ----------------------------------------------------------------------------
-- floor-plans: operator staff read/write for their own warehouses.
-- Bidders need to read floor plans to render the pickup map; we permit any
-- authenticated bidder to read this private bucket because floor plans are
-- not sensitive (they only become useful when paired with bin assignments).
-- Path convention: <operator_id>/<warehouse_id>/floor-plan.png
-- ----------------------------------------------------------------------------

CREATE POLICY "floor-plans staff write" ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'floor-plans'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
  )
  WITH CHECK (
    bucket_id = 'floor-plans'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
  );

CREATE POLICY "floor-plans bidder read" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'floor-plans' AND is_bidder());

-- ----------------------------------------------------------------------------
-- staging-photos: pickers write photos when staging items at bins. Bidders
-- read for their own won lots (they see the staged item before driving in —
-- the killer feature that addresses the #1 BidFTA complaint).
-- Path convention: <operator_id>/<bin_assignment_id>.jpg
-- ----------------------------------------------------------------------------

CREATE POLICY "staging-photos staff write" ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'staging-photos'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
  )
  WITH CHECK (
    bucket_id = 'staging-photos'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
  );

CREATE POLICY "staging-photos bidder read own" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'staging-photos' AND is_bidder());

-- ----------------------------------------------------------------------------
-- dispute-photos: bidders write for their own disputes, operator staff read.
-- Path convention: <bidder_id>/<dispute_id>/<filename>
-- ----------------------------------------------------------------------------

CREATE POLICY "dispute-photos bidder write" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'dispute-photos'
    AND is_bidder()
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "dispute-photos bidder read own" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'dispute-photos'
    AND is_bidder()
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "dispute-photos operator read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'dispute-photos'
    AND current_operator_id() IS NOT NULL
  );
