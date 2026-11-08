-- ============================================================================
-- 0091_security_audit_fixes.sql
--
-- Fixes from the 2026-05-18 security audit:
--
--   F-01 CRITICAL: operator_users_self_update RLS policy lets any user
--     UPDATE their own role to 'admin' via direct PostgREST, defeating
--     MFA enforcement (0086). Replace with SECURITY DEFINER RPCs that
--     allow only the two legitimate self-writes.
--
--   F-02 HIGH: operator_policies UPDATE policy missing WITH CHECK clause —
--     admin of operator A could retag a row to operator B. Add the missing
--     clause.
--
--   F-04 MEDIUM: record_operator_consent doesn't validate published=TRUE.
--     A bidder calling the RPC directly could record acceptance of a draft
--     policy. Add a published check.
--
--   F-09 MEDIUM: seed-default-v1 content_hash is the literal string instead
--     of an actual SHA-256 of the markdown body. Recompute in both the
--     0088 seed (handled by re-running this migration which fixes the
--     trigger; existing rows are updated below) and the 0090 trigger.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- F-01: replace the open self_update policy with column-scoped RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop the dangerous wildcard self-update policy
DROP POLICY IF EXISTS operator_users_self_update ON operator_users;

-- RPC 1: bidder/operator-user clears their own force_password_rotate flag
-- AFTER they have successfully rotated their password. The RPC itself does
-- NOT verify the password rotation — the caller (Supabase Auth's
-- updateUser → set password) must have happened first. We trust the calling
-- route did its job; SECURITY DEFINER just lets the update bypass RLS.
CREATE OR REPLACE FUNCTION clear_force_password_rotate()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_rows INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  UPDATE operator_users
     SET force_password_rotate = FALSE
   WHERE user_id = v_user_id
     AND force_password_rotate = TRUE;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'rows_updated', v_rows);
END;
$$;

GRANT EXECUTE ON FUNCTION clear_force_password_rotate() TO authenticated;

-- RPC 2: stamps admin_first_seen_at = now() for the caller, exactly once.
-- Subsequent calls are no-ops (already stamped). Used by the operator
-- layout to start the 7-day MFA grace period clock.
CREATE OR REPLACE FUNCTION stamp_admin_first_seen()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_now TIMESTAMPTZ := now();
  v_rows INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- Only stamp when role = 'admin' and not already stamped.
  UPDATE operator_users
     SET admin_first_seen_at = v_now
   WHERE user_id = v_user_id
     AND role = 'admin'
     AND admin_first_seen_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'rows_updated', v_rows, 'stamped_at', v_now);
END;
$$;

GRANT EXECUTE ON FUNCTION stamp_admin_first_seen() TO authenticated;

COMMENT ON FUNCTION clear_force_password_rotate() IS
  'Replaces the dangerous operator_users_self_update RLS policy (audit F-01). '
  'Allows the caller to clear their own force_password_rotate flag after '
  'rotating their password. Cannot escalate role.';

COMMENT ON FUNCTION stamp_admin_first_seen() IS
  'Replaces the dangerous operator_users_self_update RLS policy (audit F-01). '
  'Stamps admin_first_seen_at = now() for the caller exactly once. Used by '
  'the operator layout to start the 7-day MFA grace period clock.';

-- ─────────────────────────────────────────────────────────────────────────────
-- F-02: operator_policies UPDATE policy needs WITH CHECK
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "operator_policies: operator-admin update own" ON operator_policies;

CREATE POLICY "operator_policies: operator-admin update own"
  ON operator_policies FOR UPDATE
  USING (
    operator_id IN (
      SELECT operator_id FROM operator_users
       WHERE user_id = auth.uid() AND role = 'admin'
    )
  )
  WITH CHECK (
    operator_id IN (
      SELECT operator_id FROM operator_users
       WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- F-04: record_operator_consent must validate published = TRUE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION record_operator_consent(
  p_operator_id UUID,
  p_version INT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_user_id UUID;
  v_ip      TEXT;
  v_ua      TEXT;
  v_id      UUID;
  v_published BOOLEAN;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'record_operator_consent: caller is not authenticated';
  END IF;

  -- Audit F-04: only accept consent for PUBLISHED policy versions. A bidder
  -- calling the RPC directly with a draft version would have no real terms
  -- to consent to. A backdated published-after-consent flow is also blocked.
  SELECT published INTO v_published
    FROM operator_policies
   WHERE operator_id = p_operator_id AND version = p_version;

  IF v_published IS NULL THEN
    RAISE EXCEPTION 'record_operator_consent: policy version not found'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_published IS NOT TRUE THEN
    RAISE EXCEPTION 'record_operator_consent: policy version not published'
      USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    v_ip := current_setting('request.headers.x-forwarded-for', true);
  EXCEPTION WHEN OTHERS THEN v_ip := NULL; END;
  BEGIN
    v_ua := current_setting('request.headers.user-agent', true);
  EXCEPTION WHEN OTHERS THEN v_ua := NULL; END;

  INSERT INTO operator_policy_acceptances (user_id, operator_id, version, ip_address, user_agent)
  VALUES (v_user_id, p_operator_id, p_version, v_ip, v_ua)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$func$;

GRANT EXECUTE ON FUNCTION record_operator_consent(UUID, INT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- F-09: real SHA-256 content_hash, replace 'seed-default-v1' placeholder
-- ─────────────────────────────────────────────────────────────────────────────

-- Update existing seed rows to use a real hash. pgcrypto lives in the
-- `extensions` schema on Supabase, so we qualify the digest() call rather
-- than rely on search_path.
UPDATE operator_policies
   SET content_hash = encode(
         extensions.digest(terms_md || E'\n----\n' || refund_md || E'\n----\n' || shipping_md, 'sha256'),
         'hex'
       )
 WHERE content_hash = 'seed-default-v1';

-- Update the trigger to compute real SHA-256 going forward.
CREATE OR REPLACE FUNCTION seed_default_operator_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
-- pgcrypto lives in extensions schema on Supabase; include it on search_path
-- so digest() resolves without explicit qualification.
SET search_path = public, extensions
AS $$
DECLARE
  v_terms TEXT;
  v_refund TEXT;
  v_shipping TEXT;
BEGIN
  v_terms :=
    '# Operator Terms' || E'\n\n' ||
    'By placing a bid on an auction operated by ' || COALESCE(NEW.business_name, 'this operator') || ', you agree to these terms in addition to the [ClovrBid Terms of Service](/legal/terms) and [Bidder Agreement](/legal/bidder-agreement).' || E'\n\n' ||
    '## Payment' || E'\n' ||
    'Payment is due immediately on winning. Your saved payment method will be charged at auction close.' || E'\n\n' ||
    '## Pickup window' || E'\n' ||
    'You have 7 days from auction close to pick up your won items.' || E'\n\n' ||
    '## Inspection' || E'\n' ||
    'You may inspect items at the pickup counter before accepting them. Refunds for damaged or misdescribed items are issued at the pickup counter only.' || E'\n\n' ||
    '## All sales final after pickup' || E'\n' ||
    'Once items leave our warehouse with you, all sales are final. No returns, no refunds.' || E'\n\n' ||
    '## Suspension for non-payment / no-show' || E'\n' ||
    'Repeated payment failures or pickup no-shows may result in suspension from bidding with this operator.';

  v_refund :=
    '# Refund Policy' || E'\n\n' ||
    'Refunds are issued at the pickup counter for items that materially differ from the listing description, or that are damaged in a way not disclosed in the listing.' || E'\n\n' ||
    'To request a refund, decline the item at pickup and present it to the pickup attendant. We will issue a refund to your original payment method within 5 business days.' || E'\n\n' ||
    'After items leave the warehouse, refunds are not available. No exceptions.';

  v_shipping :=
    '# Shipping Policy' || E'\n\n' ||
    'This operator does not currently offer shipping. All items are pickup-only at our warehouse during posted pickup hours.';

  INSERT INTO operator_policies
    (operator_id, version, terms_md, refund_md, shipping_md,
     payment_window_hours, pickup_window_days, shipping_offered,
     refund_window_post_pickup_hours, published, content_hash, created_at)
  VALUES (
    NEW.id, 1, v_terms, v_refund, v_shipping,
    0, 7, FALSE, 0, TRUE,
    encode(digest(v_terms || E'\n----\n' || v_refund || E'\n----\n' || v_shipping, 'sha256'), 'hex'),
    now()
  )
  ON CONFLICT (operator_id, version) DO NOTHING;

  RETURN NEW;
END;
$$;
