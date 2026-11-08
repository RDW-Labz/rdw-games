-- ============================================================================
-- Phase C security audit — fixes for findings C3, C4, H2, H3, H4, H5, H7,
-- and storage hardening (dispute-photos cross-tenant, floor-plans / staging-
-- photos / bin-landmarks cross-bidder, file-size + MIME enforcement). Plus
-- M-tier next_lot_code DoS guard.
--
-- Apply order matters: helpers + triggers first, then policies, then storage,
-- then function patches. Each section is idempotent — safe to re-run.
--
-- See docs/HANDOFF.md for the original audit findings list. Highlights:
--
--   C3  disputes_self_all let a bidder forge disputes against any lot/operator
--   C4  enqueue_notification SECURITY DEFINER granted to PUBLIC by default
--   H2  bidders_self_insert let user write any email into their own row
--   H3  bidder_subs_operator_read exposed Stripe IDs to picker role
--   H4  *_staff_all policies let pickers mutate financial fields
--   H5  pickups_self_update let bidder forge status='completed'
--   H7  confirm_pickup didn't verify bidder is at the correct operator
-- ============================================================================

-- ----------------------------------------------------------------------------
-- C4: REVOKE PUBLIC EXECUTE on enqueue_notification.
--
-- The function is SECURITY DEFINER. By default Postgres grants EXECUTE to
-- PUBLIC for new functions, which means any authenticated user can call it
-- and push an arbitrary notification (with attacker-controlled payload) to
-- any other user. The legitimate callers (place_bid, finalize_lot,
-- assign_lot_to_bin, mark_pickup_ready, confirm_pickup) are themselves
-- SECURITY DEFINER and inherit definer rights — so this REVOKE doesn't break
-- any internal call sites.
-- ----------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION enqueue_notification(notification_kind, UUID, JSONB, TEXT) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- M: next_lot_code caller-must-be-staff-of-operator guard.
--
-- The function was granted EXECUTE to authenticated. Any bidder could call
-- it with an arbitrary operator_id and burn that operator's lot sequence by
-- bumping next_lot_seq repeatedly. Add a guard at the top of the body.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION next_lot_code(p_operator_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code TEXT;
  v_caller_op UUID;
BEGIN
  -- Caller must be staff of the operator. Bypassed when called from another
  -- SECURITY DEFINER (auth.uid() returns NULL inside the engine workers via
  -- service-role). We allow that case so the cache-warm worker, intake RPCs,
  -- etc. can mint codes when needed.
  IF auth.uid() IS NOT NULL THEN
    SELECT operator_id INTO v_caller_op
    FROM operator_users WHERE user_id = auth.uid()
    LIMIT 1;
    IF v_caller_op IS NULL OR v_caller_op <> p_operator_id THEN
      RAISE EXCEPTION 'next_lot_code: caller is not staff of the operator'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE operators
     SET next_lot_seq = next_lot_seq + 1
   WHERE id = p_operator_id
   RETURNING code || '-' || LPAD(next_lot_seq::TEXT, 6, '0') INTO v_code;

  IF v_code IS NULL THEN
    RAISE EXCEPTION 'next_lot_code: operator not found'
      USING ERRCODE = '02000';
  END IF;
  RETURN v_code;
END;
$$;

-- ----------------------------------------------------------------------------
-- H2: Force bidders.email and bidders.phone to come from auth.users only.
--
-- bidders_self_insert / bidders_self_update only check id = auth.uid() —
-- they don't enforce email/phone match the underlying auth row. A bidder
-- could set their bidders.email to anyone's address, blocking that real
-- user from registering and corrupting operator-side bidder lookups.
-- A trigger pulls the canonical email from auth.users on every write.
-- Phone we leave untouched (operator collection of phone for SMS notify is
-- operator/bidder-managed, not auth-derived).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION bidders_lock_email_to_auth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth_email TEXT;
BEGIN
  SELECT email INTO v_auth_email FROM auth.users WHERE id = NEW.id;
  IF v_auth_email IS NULL THEN
    RAISE EXCEPTION 'bidders.email: no matching auth.users row for id=%', NEW.id
      USING ERRCODE = '23503';
  END IF;
  NEW.email := v_auth_email;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bidders_lock_email_to_auth ON bidders;
CREATE TRIGGER bidders_lock_email_to_auth
  BEFORE INSERT OR UPDATE OF email ON bidders
  FOR EACH ROW EXECUTE FUNCTION bidders_lock_email_to_auth();

-- ----------------------------------------------------------------------------
-- C3: Replace disputes_self_all with INSERT-validates-invoice + SELECT-only.
--
-- The original policy let a bidder INSERT a dispute with any operator_id /
-- invoice_id / lot_id, and UPDATE their own dispute's resolution_notes /
-- refund_cents. We restrict INSERT to disputes referencing the bidder's
-- OWN invoice (and matching operator_id), and forbid direct UPDATE entirely
-- (operator staff still resolve via disputes_staff_write below).
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS disputes_self_all ON disputes;

CREATE POLICY disputes_self_read ON disputes
  FOR SELECT
  USING (bidder_id = auth.uid());

CREATE POLICY disputes_self_insert ON disputes
  FOR INSERT
  WITH CHECK (
    bidder_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = disputes.invoice_id
        AND i.bidder_id = auth.uid()
        AND i.operator_id = disputes.operator_id
    )
  );

-- No self UPDATE / DELETE; the disputes_staff_write policy below replaces
-- the previous disputes_staff_all on the operator side.

-- ----------------------------------------------------------------------------
-- H4: Split *_staff_all policies into role-gated SELECT + write.
--
-- The FOR ALL pattern lets pickers (warehouse staff) mutate financial fields
-- like starting_bid_cents on lots, total_cents on invoices, status on
-- auctions. Real exploit: a disgruntled picker tanks an auction by zeroing
-- prices. Split each into:
--   *_staff_read   — all staff
--   *_staff_write  — admin/manager only (DELETE = admin only on lots/auctions)
-- ----------------------------------------------------------------------------

-- LOTS ---------------------------------------------------------------------
DROP POLICY IF EXISTS lots_staff_all ON lots;

CREATE POLICY lots_staff_read ON lots
  FOR SELECT
  USING (operator_id = current_operator_id());

CREATE POLICY lots_staff_insert ON lots
  FOR INSERT
  WITH CHECK (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

-- UPDATE allowed for admin/manager (full row), and for picker on a narrow
-- set of inventory/intake fields via the existing intake_lot_to_bin RPC
-- (SECURITY DEFINER bypasses this policy). Direct picker UPDATE through
-- PostgREST is blocked.
CREATE POLICY lots_staff_update ON lots
  FOR UPDATE
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

CREATE POLICY lots_staff_delete ON lots
  FOR DELETE
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() = 'admin'
  );

-- AUCTIONS -----------------------------------------------------------------
DROP POLICY IF EXISTS auctions_staff_all ON auctions;

CREATE POLICY auctions_staff_read ON auctions
  FOR SELECT
  USING (operator_id = current_operator_id());

CREATE POLICY auctions_staff_insert ON auctions
  FOR INSERT
  WITH CHECK (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

CREATE POLICY auctions_staff_update ON auctions
  FOR UPDATE
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

CREATE POLICY auctions_staff_delete ON auctions
  FOR DELETE
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() = 'admin'
  );

-- WAREHOUSES ---------------------------------------------------------------
DROP POLICY IF EXISTS warehouses_staff_all ON warehouses;

CREATE POLICY warehouses_staff_read ON warehouses
  FOR SELECT
  USING (operator_id = current_operator_id());

CREATE POLICY warehouses_staff_write ON warehouses
  FOR INSERT
  WITH CHECK (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

CREATE POLICY warehouses_staff_update ON warehouses
  FOR UPDATE
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

CREATE POLICY warehouses_staff_delete ON warehouses
  FOR DELETE
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() = 'admin'
  );

-- INVOICES -----------------------------------------------------------------
-- Note: invoices are written by the buildInvoices BullMQ worker via service
-- role (bypasses RLS). Staff direct write was overly broad; restrict to
-- admin/manager for the manual edit case.
DROP POLICY IF EXISTS invoices_staff_all ON invoices;

CREATE POLICY invoices_staff_read ON invoices
  FOR SELECT
  USING (operator_id = current_operator_id());

CREATE POLICY invoices_staff_update ON invoices
  FOR UPDATE
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

CREATE POLICY invoices_staff_delete ON invoices
  FOR DELETE
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() = 'admin'
  );

-- DISPUTES -----------------------------------------------------------------
DROP POLICY IF EXISTS disputes_staff_all ON disputes;

CREATE POLICY disputes_staff_read ON disputes
  FOR SELECT
  USING (operator_id = current_operator_id());

CREATE POLICY disputes_staff_update ON disputes
  FOR UPDATE
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

-- ----------------------------------------------------------------------------
-- H5: Drop pickups_self_update.
--
-- A bidder could `update pickups set status='completed', completed_at=now()`
-- to forge a successful pickup, undermining no-show tracking. The legitimate
-- bidder-side flow is the schedule_pickup RPC for scheduling; completion is
-- always staff-mediated (confirm_pickup RPC, scanned by the bidder using
-- a bin QR but write done as the staff/operator path).
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS pickups_self_update ON pickups;

-- ----------------------------------------------------------------------------
-- H3: Tighten bidder_subs_operator_read to admin/manager only.
--
-- The previous policy exposed stripe_subscription_id to all operator staff
-- including picker role. There's no warehouse-floor reason for picker to
-- see Stripe identifiers.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS bidder_subs_operator_read ON bidder_subscriptions;

CREATE POLICY bidder_subs_operator_read ON bidder_subscriptions
  FOR SELECT
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

-- ----------------------------------------------------------------------------
-- H7: confirm_pickup operator scope.
--
-- The original function took a bin's QR token and updated any 'staged'
-- bin_assignments where the bidder was the lot owner — without verifying
-- that the bin's warehouse belongs to the same operator as the bidder's
-- invoice. Cross-operator scenario: a bidder with invoices at op A and
-- op B, scanning op B's bin QR, would flip her staged-at-B lots to
-- picked_up even if she's at op A's warehouse.
--
-- Fix: scope the bidder_owned join through invoices.operator_id matching
-- the bin's warehouse's operator_id.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION confirm_pickup(
  p_bin_qr_token TEXT
)
RETURNS TABLE (
  bin_id UUID,
  bin_label TEXT,
  warehouse_id UUID,
  warehouse_name TEXT,
  picked_up_count INT,
  remaining_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bidder_id UUID := auth.uid();
  v_bin RECORD;
  v_op_id UUID;
  v_picked INT;
  v_remaining INT;
BEGIN
  IF v_bidder_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- Resolve bin from QR + grab the bin's operator via warehouse.
  SELECT b.*, w.operator_id AS warehouse_operator_id, w.name AS warehouse_name
    INTO v_bin
  FROM bins b
  JOIN warehouses w ON w.id = b.warehouse_id
  WHERE b.qr_token = p_bin_qr_token;

  IF v_bin.id IS NULL THEN
    RAISE EXCEPTION 'bin_not_found' USING ERRCODE = '02000';
  END IF;
  v_op_id := v_bin.warehouse_operator_id;

  -- Flip every still-staged bin_assignment for this bin → picked_up,
  -- but ONLY when the lot's invoice belongs to this bidder AND the
  -- invoice's operator matches the bin's warehouse operator.
  WITH bidder_owned AS (
    SELECT ba.id, il.lot_id
    FROM bin_assignments ba
    JOIN invoice_lots il ON il.lot_id = ba.lot_id
    JOIN invoices i ON i.id = il.invoice_id
    WHERE ba.bin_id = v_bin.id
      AND ba.status = 'staged'
      AND i.bidder_id = v_bidder_id
      AND i.operator_id = v_op_id
  )
  UPDATE bin_assignments ba
     SET status = 'picked_up',
         picked_up_at = now()
   FROM bidder_owned bo
   WHERE ba.id = bo.id;

  GET DIAGNOSTICS v_picked = ROW_COUNT;

  -- Remaining staged for this bidder at this bin (almost always 0 after the
  -- update, but kept for symmetry and for partial-pickup future use).
  SELECT COUNT(*) INTO v_remaining
  FROM bin_assignments ba
  JOIN invoice_lots il ON il.lot_id = ba.lot_id
  JOIN invoices i ON i.id = il.invoice_id
  WHERE ba.bin_id = v_bin.id
    AND ba.status = 'staged'
    AND i.bidder_id = v_bidder_id
    AND i.operator_id = v_op_id;

  RETURN QUERY SELECT
    v_bin.id,
    v_bin.label,
    v_bin.warehouse_id,
    v_bin.warehouse_name,
    v_picked,
    v_remaining::INT;
END;
$$;

-- ----------------------------------------------------------------------------
-- Storage policy hardening — dispute-photos cross-tenant read.
--
-- Original policy let any operator staff read every operator's dispute
-- photos (path: <bidder_id>/<dispute_id>/<filename>). Tighten to require the
-- dispute belongs to the caller's operator.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "dispute-photos operator read" ON storage.objects;

CREATE POLICY "dispute-photos operator read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'dispute-photos'
    AND current_operator_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM disputes d
      WHERE (storage.foldername(name))[2] = d.id::text
        AND d.operator_id = current_operator_id()
    )
  );

-- ----------------------------------------------------------------------------
-- Storage policy hardening — floor-plans + staging-photos + bin-landmarks
-- cross-bidder read. Original policies were is_bidder() with no scope, so
-- any authed bidder could read any operator's plans/photos by knowing path
-- (UUIDs are unguessable in practice but enumerable via the Storage list
-- API). Tighten to bidders who have at least one paid invoice tied to that
-- operator.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "floor-plans bidder read" ON storage.objects;
DROP POLICY IF EXISTS "staging-photos bidder read own" ON storage.objects;
DROP POLICY IF EXISTS "bin-landmarks bidder read" ON storage.objects;

-- floor-plans path: <operator_id>/<warehouse_id>/floor-plan.<ext>
CREATE POLICY "floor-plans bidder read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'floor-plans'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.bidder_id = auth.uid()
        AND i.status = 'paid'
        AND i.operator_id::text = (storage.foldername(name))[1]
    )
  );

-- staging-photos path: <operator_id>/<bin_assignment_id>.jpg
CREATE POLICY "staging-photos bidder read own" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'staging-photos'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM bin_assignments ba
      JOIN invoice_lots il ON il.lot_id = ba.lot_id
      JOIN invoices i ON i.id = il.invoice_id
      WHERE ba.id::text = split_part(
              (storage.foldername(name))[2],
              '.',
              1
            )
        AND i.bidder_id = auth.uid()
    )
  );

-- bin-landmarks path: <operator_id>/<warehouse_id>/<bin_id>.jpg
-- A bidder needs to see the landmark only for bins where they have a
-- staged-or-later assignment.
CREATE POLICY "bin-landmarks bidder read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'bin-landmarks'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM bin_assignments ba
      JOIN invoice_lots il ON il.lot_id = ba.lot_id
      JOIN invoices i ON i.id = il.invoice_id
      WHERE ba.bin_id::text = split_part(
              (storage.foldername(name))[3],
              '.',
              1
            )
        AND ba.status IN ('staged', 'picked_up')
        AND i.bidder_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- Storage bucket file-size + MIME enforcement.
--
-- DoS: bidders could fill dispute-photos with arbitrary multi-MB files.
-- Operators could host arbitrary content on the public lot-photos CDN.
-- Set per-bucket limits at the storage.buckets level.
-- ----------------------------------------------------------------------------

UPDATE storage.buckets SET
  file_size_limit = 10485760,                         -- 10 MB
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp']
WHERE id IN (
  'lot-photos',
  'floor-plans',
  'dispute-photos',
  'staging-photos',
  'operator-logos',
  'bin-landmarks'
);

-- ----------------------------------------------------------------------------
-- product_lookups L5 — tighten the global cache to read-public, write-only-
-- service-role. Any operator's staff (including picker) was previously able
-- to UPDATE/DELETE the platform-shared cache via the staff_write policy,
-- which means they could poison entries (wrong title/MSRP/sold-comps) for
-- every operator. Server-side route handlers + auction-engine workers do
-- the upserts via the admin client; staff don't need direct write access.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS product_lookups_staff_write ON product_lookups;

-- product_lookups_authed_read stays — every authed user can read.
-- All writes now flow through service-role (admin client), which bypasses
-- RLS. The /api/lottr/* routes and packages/auction-engine/src/product*
-- both already use the admin / service-role path.

-- ----------------------------------------------------------------------------
-- Audit summary view (operator-facing, optional)
--
-- Helpful for the cache stats page already shipped in /lottr/cache. Not
-- security-relevant; included so the migration is self-contained.
-- ----------------------------------------------------------------------------
-- (intentionally empty; cache stats page queries product_lookups directly.)
