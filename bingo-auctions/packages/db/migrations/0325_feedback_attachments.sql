-- 0325 — screenshots and screen recordings on feedback reports.
--
-- Owner ask 2026-08-18: "make sure they can upload screen record or ss as well
-- as messages." Every report so far has been prose about a UI nobody watching
-- could see. Tammy's "it backs me out when I go to Amazon" took three rounds of
-- questions to place; a five-second recording would have placed it instantly.
--
-- ── WHY A SEPARATE BUCKET ────────────────────────────────────────────────────
-- Not lot-photos: that one is PUBLIC (it backs the auction listings), and a
-- screen recording of the staff app shows bidder names, invoice totals and
-- whatever else was on screen. This bucket is private, and the console reads it
-- through short-lived signed URLs.
--
-- ── SIZE AND TYPES ───────────────────────────────────────────────────────────
-- 50 MB, video/* allowed. Bigger than any other bucket here because a phone
-- screen recording is an order of magnitude larger than a photo — a 10 MB cap
-- would reject the exact evidence this exists to collect. The client uploads by
-- streaming from disk rather than base64 (lib/upload-file.ts): these phones are
-- already dying under memory pressure, and reading a 40 MB file into a base64
-- string to upload it would be a self-inflicted version of the bug we are
-- trying to photograph.
--
-- ── PATHS ────────────────────────────────────────────────────────────────────
-- <auth.uid()>/<uuid>.<ext>. The uid prefix is what the INSERT policy checks,
-- so a device can only write under its own folder and cannot overwrite another
-- reporter's evidence.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
-- jsonb rather than text[]: the console needs the content type to decide
-- between <img> and <video>, and the byte count to warn about an upload that
-- was truncated. Shape: [{"path":"...","content_type":"...","bytes":123}]
ALTER TABLE public.app_feedback
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.app_feedback.attachments IS
  '0325: screenshots / screen recordings for this report. Array of '
  '{path, content_type, bytes} pointing into the feedback-attachments bucket. '
  'Private bucket — read through signed URLs, never linked directly.';

-- A report with fifty attachments is a bug or an abuse, not a bug report.
ALTER TABLE public.app_feedback
  DROP CONSTRAINT IF EXISTS app_feedback_attachments_shape;
ALTER TABLE public.app_feedback
  ADD CONSTRAINT app_feedback_attachments_shape
  CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 6);

-- ---------------------------------------------------------------------------
-- 2. The bucket
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'feedback-attachments',
  'feedback-attachments',
  false,
  52428800,
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'video/mp4', 'video/quicktime'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit   = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public             = false;

-- ---------------------------------------------------------------------------
-- 3. Policies
-- ---------------------------------------------------------------------------
-- INSERT: any signed-in account, but only under its own uid folder. Bidders
-- file feedback too (0317), so this is deliberately not staff-only.
DROP POLICY IF EXISTS feedback_attach_own_insert ON storage.objects;
CREATE POLICY feedback_attach_own_insert
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'feedback-attachments'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

-- SELECT: the uploader (so the app can show what it just attached) and operator
-- staff (who triage). Mirrors app_feedback's own read policies in 0317 — the
-- attachment must not be more widely readable than the report it belongs to.
DROP POLICY IF EXISTS feedback_attach_read ON storage.objects;
CREATE POLICY feedback_attach_read
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'feedback-attachments'
    AND (
      (storage.foldername(name))[1] = (SELECT auth.uid())::text
      OR EXISTS (
        SELECT 1 FROM public.operator_users ou
        WHERE ou.user_id = (SELECT auth.uid())
      )
    )
  );

COMMIT;
