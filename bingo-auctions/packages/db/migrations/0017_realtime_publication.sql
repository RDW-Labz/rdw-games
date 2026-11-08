-- ============================================================================
-- Add the tables we subscribe to from the bidder app to Supabase
-- Realtime's publication. Without these, postgres_changes events
-- never fire — the channel subscribes successfully but no UPDATE
-- payloads arrive, and the bidder app sits with stale lot state until
-- the user navigates back and re-fetches.
--
-- Symptom that surfaced this: after placing a bid, the red Outbid
-- banner's one-tap counter button kept showing the previous next-min
-- because the lot row's local state never refreshed.
--
-- ALTER PUBLICATION ... ADD TABLE errors if the table is already a
-- member (and DROP TABLE IF EXISTS isn't valid syntax for
-- publications). Wrap each ADD in a DO block that no-ops if the
-- table is already published, so re-running this migration is safe.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'lots'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE lots;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'bids'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE bids;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'bin_assignments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE bin_assignments;
  END IF;
END $$;
