-- ============================================================================
-- Migration 0079 — Staff pickup verification + confirm_pickup bug fix
--
-- A. Fix confirm_pickup (bidder self-scan) to also update pickups table and
--    fire the pickup_confirmed notification. Previously it only flipped
--    bin_assignments.status; pickups rows hung in 'scheduled' forever.
--
-- B. New RPC staff_confirm_pickup(p_invoice_id, p_lot_codes[]):
--    Staff-mediated pickup handoff. Requires operator staff caller whose
--    operator_id matches the invoice. Flips bin_assignments, closes the
--    pickup row, and enqueues the pickup_confirmed notification.
--    Idempotent — safe to call twice.
--
-- C. Add bidder_signature_url to pickups for optional on-screen signature.
--    Storage bucket policy documented below; bucket must be created in the
--    Supabase dashboard (or via supabase-js admin call) since SQL can't
--    create buckets.
-- ============================================================================

-- ============================================================================
-- C. Schema additions
-- ============================================================================

-- Signature image URL pointing to pickup-signatures/{operator_id}/{pickup_id}.png
ALTER TABLE pickups ADD COLUMN IF NOT EXISTS bidder_signature_url TEXT;

-- ============================================================================
-- STORAGE BUCKET: pickup-signatures
-- ============================================================================
-- Create this bucket in the Supabase dashboard:
--   Name: pickup-signatures
--   Public: NO (private)
--   File size limit: 5 MB
--   Allowed MIME types: image/png, image/jpeg
--
-- Then apply these storage RLS policies in the dashboard (SQL editor):
--
-- Policy 1 — operator staff INSERT (upload)
--   CREATE POLICY "staff upload pickup signature"
--   ON storage.objects FOR INSERT
--   WITH CHECK (
--     bucket_id = 'pickup-signatures'
--     AND auth.uid() IS NOT NULL
--     AND EXISTS (
--       SELECT 1 FROM public.operator_users
--       WHERE user_id = auth.uid()
--         AND operator_id::text = (storage.foldername(name))[1]
--     )
--   );
--
-- Policy 2 — operator staff SELECT (read own operator's signatures)
--   CREATE POLICY "staff read own operator pickup signatures"
--   ON storage.objects FOR SELECT
--   USING (
--     bucket_id = 'pickup-signatures'
--     AND auth.uid() IS NOT NULL
--     AND EXISTS (
--       SELECT 1 FROM public.operator_users
--       WHERE user_id = auth.uid()
--         AND operator_id::text = (storage.foldername(name))[1]
--     )
--   );
--
-- No public read. Bidders cannot read these. Bidder signature upload is done
-- by the staff device on the bidder's behalf (staff is signed in).
-- ============================================================================

-- ============================================================================
-- A. Fix confirm_pickup — update pickups table + notify
-- ============================================================================

CREATE OR REPLACE FUNCTION confirm_pickup(p_bin_qr_token UUID)
RETURNS confirm_pickup_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user      UUID := auth.uid();
  v_bin       bins%ROWTYPE;
  v_lot_ids   UUID[];
  v_count     INTEGER := 0;
  v_result    confirm_pickup_result;
  v_invoice   RECORD;
BEGIN
  IF v_user IS NULL THEN
    v_result := (false, 'not_authenticated', 0, NULL, NULL, ARRAY[]::UUID[]);
    RETURN v_result;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM bidders WHERE id = v_user) THEN
    v_result := (false, 'not_a_bidder', 0, NULL, NULL, ARRAY[]::UUID[]);
    RETURN v_result;
  END IF;

  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found', 0, NULL, NULL, ARRAY[]::UUID[]);
    RETURN v_result;
  END IF;

  -- Flip staged → picked_up for all of this bidder's lots at this bin
  WITH latest_assignments AS (
    SELECT DISTINCT ON (ba.lot_id) ba.id, ba.lot_id, ba.status, ba.bin_id
    FROM bin_assignments ba
    WHERE ba.bin_id = v_bin.id
    ORDER BY ba.lot_id, ba.assigned_at DESC
  ),
  bidder_owned AS (
    SELECT la.id, la.lot_id
    FROM latest_assignments la
    JOIN invoice_lots il ON il.lot_id = la.lot_id
    JOIN invoices i ON i.id = il.invoice_id
    WHERE i.bidder_id = v_user
      AND i.status = 'paid'
      AND la.status = 'staged'
  ),
  picked AS (
    UPDATE bin_assignments
    SET status = 'picked_up', picked_up_at = now()
    WHERE id IN (SELECT id FROM bidder_owned)
    RETURNING lot_id
  )
  SELECT array_agg(lot_id), count(*) INTO v_lot_ids, v_count FROM picked;

  IF v_count = 0 THEN
    v_result := (false, 'no_staged_lots', 0, v_bin.id, v_bin.code, ARRAY[]::UUID[]);
    RETURN v_result;
  END IF;

  -- BUG FIX: update pickups rows for every invoice that had lots picked up.
  -- Previously this was never written; pickups stayed in 'scheduled' forever.
  FOR v_invoice IN
    SELECT DISTINCT i.id AS invoice_id, i.bidder_id
    FROM unnest(v_lot_ids) AS picked_lot(lot_id)
    JOIN invoice_lots il ON il.lot_id = picked_lot.lot_id
    JOIN invoices i ON i.id = il.invoice_id
    WHERE i.bidder_id = v_user
  LOOP
    UPDATE pickups
    SET
      checked_in_at  = COALESCE(checked_in_at, now()),
      completed_at   = now(),
      status         = 'completed',
      updated_at     = now()
    WHERE invoice_id = v_invoice.invoice_id
      AND status <> 'completed';   -- idempotent

    -- Enqueue pickup_confirmed notification once per invoice.
    -- Idempotency key prevents a double-notify if called again.
    PERFORM enqueue_notification(
      'pickup_confirmed',
      v_invoice.bidder_id,
      jsonb_build_object('invoice_id', v_invoice.invoice_id),
      'pickup_confirmed:bidder:' || v_invoice.invoice_id::TEXT
    );
  END LOOP;

  v_result := (true, 'ok', v_count, v_bin.id, v_bin.code, COALESCE(v_lot_ids, ARRAY[]::UUID[]));
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION confirm_pickup(UUID) TO authenticated;

-- ============================================================================
-- B. New RPC: staff_confirm_pickup
-- ============================================================================

DROP TYPE IF EXISTS staff_confirm_pickup_result CASCADE;
CREATE TYPE staff_confirm_pickup_result AS (
  out_pickup_id        UUID,
  out_lots_picked_count INT,
  out_warning          TEXT
);

CREATE OR REPLACE FUNCTION staff_confirm_pickup(
  p_invoice_id  UUID,
  p_lot_codes   TEXT[]
)
RETURNS staff_confirm_pickup_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user           UUID := auth.uid();
  v_operator       UUID;
  v_invoice        invoices%ROWTYPE;
  v_pickup         pickups%ROWTYPE;
  v_lot_id         UUID;
  v_lot_code       TEXT;
  v_already_picked INT := 0;
  v_not_found_ct   INT := 0;
  v_picked_ct      INT := 0;
  v_warning        TEXT := NULL;
  v_result         staff_confirm_pickup_result;
BEGIN
  -- ── Auth: caller must be operator staff ──────────────────────────────────
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT operator_id INTO v_operator
  FROM operator_users
  WHERE user_id = v_user
  LIMIT 1;

  IF v_operator IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff';
  END IF;

  -- ── Fetch invoice and cross-tenant check ─────────────────────────────────
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found';
  END IF;
  IF v_invoice.operator_id <> v_operator THEN
    RAISE EXCEPTION 'invoice_other_operator';
  END IF;
  IF v_invoice.status <> 'paid' THEN
    RAISE EXCEPTION 'invoice_not_paid';
  END IF;

  -- ── Fetch the pickup row ──────────────────────────────────────────────────
  SELECT * INTO v_pickup FROM pickups WHERE invoice_id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pickup_not_found';
  END IF;

  -- ── Idempotency: if already completed, return current state ──────────────
  IF v_pickup.status = 'completed' THEN
    v_result := (
      v_pickup.id,
      (SELECT count(*) FROM bin_assignments ba
       JOIN invoice_lots il ON il.lot_id = ba.lot_id
       WHERE il.invoice_id = p_invoice_id AND ba.status = 'picked_up'),
      'already_completed'
    );
    RETURN v_result;
  END IF;

  -- ── Per-lot flip ─────────────────────────────────────────────────────────
  FOREACH v_lot_code IN ARRAY p_lot_codes
  LOOP
    -- Resolve lot_code → lot_id, scoped to this invoice
    SELECT l.id INTO v_lot_id
    FROM lots l
    JOIN invoice_lots il ON il.lot_id = l.id
    WHERE il.invoice_id = p_invoice_id
      AND l.lot_code = v_lot_code
    LIMIT 1;

    IF NOT FOUND THEN
      v_not_found_ct := v_not_found_ct + 1;
      CONTINUE;
    END IF;

    -- Flip the latest staged assignment for this lot
    WITH latest AS (
      SELECT ba.id
      FROM bin_assignments ba
      WHERE ba.lot_id = v_lot_id
      ORDER BY ba.assigned_at DESC
      LIMIT 1
    )
    UPDATE bin_assignments ba
    SET status = 'picked_up', picked_up_at = now()
    FROM latest
    WHERE ba.id = latest.id
      AND ba.status = 'staged';

    IF FOUND THEN
      v_picked_ct := v_picked_ct + 1;
    ELSE
      -- Either already picked_up or no staged assignment
      v_already_picked := v_already_picked + 1;
    END IF;
  END LOOP;

  -- ── Close the pickup row ──────────────────────────────────────────────────
  UPDATE pickups
  SET
    checked_in_at = COALESCE(checked_in_at, now()),
    completed_at  = now(),
    status        = 'completed',
    updated_at    = now()
  WHERE id = v_pickup.id;

  -- ── Enqueue notification (idempotent) ────────────────────────────────────
  PERFORM enqueue_notification(
    'pickup_confirmed',
    v_invoice.bidder_id,
    jsonb_build_object(
      'invoice_id', p_invoice_id,
      'lots_picked', v_picked_ct
    ),
    'pickup_confirmed:staff:' || p_invoice_id::TEXT
  );

  -- ── Build warning string ─────────────────────────────────────────────────
  IF v_not_found_ct > 0 OR v_already_picked > 0 THEN
    v_warning := format(
      '%s lot(s) not in invoice; %s already picked up',
      v_not_found_ct, v_already_picked
    );
  END IF;

  v_result := (v_pickup.id, v_picked_ct, v_warning);
  RETURN v_result;
END;
$$;

-- Restrict to authenticated (operator staff guard is inside the function body).
GRANT EXECUTE ON FUNCTION staff_confirm_pickup(UUID, TEXT[]) TO authenticated;
