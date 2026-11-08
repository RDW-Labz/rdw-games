-- ============================================================================
-- operator-logos bucket — public read so the bidder app can render branding
-- on lot listings without authenticating against an operator's session.
-- Operators write to their own folder.
--
-- Path convention: <operator_id>/logo.<ext>
-- ============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('operator-logos', 'operator-logos', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "operator-logos read" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'operator-logos');

CREATE POLICY "operator-logos write — own operator" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'operator-logos'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
  );

CREATE POLICY "operator-logos update — own operator" ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'operator-logos'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
  );

CREATE POLICY "operator-logos delete — own operator" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'operator-logos'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
  );
