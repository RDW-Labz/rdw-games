-- ============================================================================
-- Migration 0195 — per-operator sales-tax mode + tax-document store + bucket.
--
-- Two modes (owner decision 2026-06-06):
--   self_managed (DEFAULT): the platform adds NO tax to charges. The operator
--     collects + remits their own sales tax and uploads their state permit /
--     registration as a compliance record. This is exactly today's behaviour
--     (charges = subtotal + buyer's premium), now made an explicit, chosen mode.
--   stripe_tax: the platform computes tax via the Stripe Tax Calculation API
--     against the OPERATOR's own connected-account registrations (operator is
--     merchant of record). BUILT but ENV-GATED OFF in app code (STRIPE_TAX_LIVE)
--     and needs a marketplace-facilitator legal sign-off before any operator is
--     switched to it.
--
-- SAFETY: every operator defaults to self_managed, which is the current no-tax
-- behaviour — so this migration changes NO live charge behaviour. The 2026-06-02
-- outage came from a config flag activating a latent bad PI param; here the
-- stripe_tax path is gated in code by an env flag, not by this column alone.
-- ============================================================================

-- ── 1. operators.tax_mode ──────────────────────────────────────────────────
ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS tax_mode TEXT NOT NULL DEFAULT 'self_managed'
    CHECK (tax_mode IN ('self_managed', 'stripe_tax'));

-- Carry forward any operator that had the (never-true-in-prod) collect_sales_tax
-- flag set. Expected 0 rows; here for correctness if a staging row had it on.
UPDATE operators SET tax_mode = 'stripe_tax' WHERE collect_sales_tax = TRUE;

COMMENT ON COLUMN operators.tax_mode IS
  'self_managed = operator collects/remits own tax, platform adds none (default); '
  'stripe_tax = platform computes via Stripe Tax Calculation API (env-gated, needs legal sign-off).';

-- ── 2. operator_tax_documents (uploaded permits / registrations) ────────────
CREATE TABLE IF NOT EXISTS operator_tax_documents (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id   UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  storage_path  TEXT NOT NULL,                       -- '<operator_id>/<uuid>.<ext>' in operator-tax-docs
  file_name     TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  doc_type      TEXT NOT NULL DEFAULT 'sales_tax_permit'
                  CHECK (doc_type IN ('sales_tax_permit', 'registration', 'resale_exemption', 'other')),
  state         TEXT CHECK (state IS NULL OR length(state) = 2),
  uploaded_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS otd_operator_recent_idx
  ON operator_tax_documents (operator_id, created_at DESC)
  WHERE archived_at IS NULL;

ALTER TABLE operator_tax_documents ENABLE ROW LEVEL SECURITY;

-- Staff of the operator can read; admin/manager can insert; admin can update/delete.
-- Mirrors the operator-scoped RLS pattern (current_operator_id / current_operator_role).
DROP POLICY IF EXISTS otd_staff_read ON operator_tax_documents;
CREATE POLICY otd_staff_read ON operator_tax_documents FOR SELECT
  USING (operator_id = current_operator_id());

DROP POLICY IF EXISTS otd_manager_insert ON operator_tax_documents;
CREATE POLICY otd_manager_insert ON operator_tax_documents FOR INSERT
  WITH CHECK (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

DROP POLICY IF EXISTS otd_admin_update ON operator_tax_documents;
CREATE POLICY otd_admin_update ON operator_tax_documents FOR UPDATE
  USING (operator_id = current_operator_id() AND current_operator_role() = 'admin');

DROP POLICY IF EXISTS otd_admin_delete ON operator_tax_documents;
CREATE POLICY otd_admin_delete ON operator_tax_documents FOR DELETE
  USING (operator_id = current_operator_id() AND current_operator_role() = 'admin');

-- ── 3. Private storage bucket for the uploaded documents (mirror 0112) ──────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'operator-tax-docs',
  'operator-tax-docs',
  false,
  10485760,                                          -- 10 MB
  ARRAY['application/pdf', 'image/png', 'image/jpeg']
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: scope to the operator that owns the path prefix (<operator_id>/…),
-- so an operator's staff can only touch their own operator's tax documents.
DROP POLICY IF EXISTS otd_bucket_staff_insert ON storage.objects;
CREATE POLICY otd_bucket_staff_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'operator-tax-docs'
    AND (storage.foldername(name))[1] IN (
      SELECT operator_id::text FROM operator_users WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS otd_bucket_staff_select ON storage.objects;
CREATE POLICY otd_bucket_staff_select ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'operator-tax-docs'
    AND (storage.foldername(name))[1] IN (
      SELECT operator_id::text FROM operator_users WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS otd_bucket_staff_delete ON storage.objects;
CREATE POLICY otd_bucket_staff_delete ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'operator-tax-docs'
    AND (storage.foldername(name))[1] IN (
      SELECT operator_id::text FROM operator_users WHERE user_id = auth.uid()
    )
  );
