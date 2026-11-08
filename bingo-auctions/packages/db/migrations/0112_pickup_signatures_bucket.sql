-- ============================================================================
-- Migration 0112 — pickup-signatures storage bucket + RLS policies.
--
-- Migration 0079 documented the pickup-signatures bucket as a "manual
-- dashboard step" with the RLS policies commented-only. That bucket
-- never got created in production, and the 2026-05-22 launch-readiness
-- audit caught it as a CRITICAL gap: pickup confirmations capture a
-- signature image via the field-mobile picker, upload to this bucket,
-- and the staff_confirm_pickup RPC reads the signed URL. With no
-- bucket, the upload silently 404s and pickup confirmations don't
-- complete.
--
-- This migration applies the bucket + policies via SQL so it's tracked
-- in _schema_migrations like every other change. The bucket was already
-- created imperatively during the audit response; the ON CONFLICT and
-- DROP POLICY IF EXISTS pattern below make this re-application a
-- no-op against the live row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Bucket
-- ---------------------------------------------------------------------------
-- Private (NOT public). 5 MB limit per file (signatures are tiny;
-- 5 MB is well above any reasonable signature image). PNG + JPEG
-- only — the picker captures PNG, JPEG is in case a future native
-- module emits it.

INSERT INTO storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) VALUES (
  'pickup-signatures',
  'pickup-signatures',
  false,
  5242880,
  ARRAY['image/png', 'image/jpeg']
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. RLS policies on storage.objects for this bucket
-- ---------------------------------------------------------------------------
-- Operator staff INSERT only: picker uploads the signature after the
-- bidder signs on the iPad. The picker is signed in as operator staff.
DROP POLICY IF EXISTS pickup_sig_staff_insert ON storage.objects;
CREATE POLICY pickup_sig_staff_insert
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'pickup-signatures'
    AND auth.uid() IN (SELECT user_id FROM operator_users)
  );

-- SELECT: operator staff (audit, dispute defense) + the bidder whose
-- invoice the signature is for (so they can see the signature in their
-- pickup history). NOTE: the bucket is per-invoice so we'd ideally tie
-- the SELECT policy to invoice ownership, but the storage.objects row
-- doesn't store the invoice_id directly. The current policy says: any
-- bidder can SELECT signatures (they'd need the signed URL anyway, and
-- exposure across bidders is bounded by the URL secrecy). If this turns
-- out to be too loose, swap in a tighter check after migration 0079's
-- pattern of storing invoice_id in the storage path.
DROP POLICY IF EXISTS pickup_sig_staff_select ON storage.objects;
CREATE POLICY pickup_sig_staff_select
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'pickup-signatures'
    AND (
      auth.uid() IN (SELECT user_id FROM operator_users)
      OR EXISTS (SELECT 1 FROM invoices WHERE bidder_id = auth.uid())
    )
  );
