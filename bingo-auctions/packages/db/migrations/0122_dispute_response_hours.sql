-- ============================================================================
-- 0122_dispute_response_hours.sql
--
-- Launch audit L0 #3 (2026-05-22): operators must see at a glance which open
-- disputes are about to age out of their SLA response window. Missing a
-- chargeback / dispute response deadline is direct financial liability — if
-- the operator doesn't respond in time, the bidder's filing stands by default
-- and the operator eats the refund + chargeback fee.
--
-- This migration adds `operator_policies.dispute_response_hours`, the
-- operator's SLA to respond to a bidder-filed dispute. The /disputes UI shows
-- a countdown badge computed from `disputes.created_at + dispute_response_hours`.
-- Default is 72 hours (3 days), which gives a typical small operator a long
-- weekend to triage. Range capped at 720 (30 days) to keep the badge math
-- sane.
--
-- Note: this is NOT the same as `refund_window_post_pickup_hours`, which is
-- the BIDDER's window to FILE a dispute (default 48h post-pickup per audit
-- C6/H4, migration 0093). The new column is the OPERATOR's window to RESPOND
-- to a filed dispute, which is downstream of that.
-- ============================================================================

-- ── 1. Add the column (idempotent) ──────────────────────────────────────────

ALTER TABLE operator_policies
  ADD COLUMN IF NOT EXISTS dispute_response_hours INT NOT NULL DEFAULT 72
    CHECK (dispute_response_hours BETWEEN 1 AND 720);

COMMENT ON COLUMN operator_policies.dispute_response_hours IS
  'Operator SLA to respond to a bidder-filed dispute, in hours. UI shows '
  'countdown badge from disputes.created_at + dispute_response_hours. '
  'Default 72h; range 1-720. Added by launch audit L0 #3 (2026-05-22).';

-- ── 2. Re-seed the trigger function so new operators get the new column ────
-- Body is byte-identical to migration 0093 except we add
-- `dispute_response_hours` to the column list and pass `72` in VALUES.
-- All other field wording (v_terms / v_refund / v_shipping) is preserved.

CREATE OR REPLACE FUNCTION seed_default_operator_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
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
    'You may inspect items at the pickup counter before accepting them. Pickup-counter refunds are issued for items that materially differ from the listing description.' || E'\n\n' ||
    '## After pickup — 48-hour dispute window' || E'\n' ||
    'Once items leave our warehouse with you, you have **48 hours from pickup** to open a dispute through the ClovrBid app if an item materially differs from what was described. After 48 hours, the sale is final per the platform [Bidder Agreement](/legal/bidder-agreement).' || E'\n\n' ||
    '## Suspension for non-payment / no-show' || E'\n' ||
    'Repeated payment failures or pickup no-shows may result in suspension from bidding with this operator.';

  v_refund :=
    '# Refund Policy' || E'\n\n' ||
    'Refunds are issued at the pickup counter for items that materially differ from the listing description, or that are damaged in a way not disclosed in the listing.' || E'\n\n' ||
    'To request a refund at the counter, decline the item at pickup and present it to the pickup attendant. We will issue a refund to your original payment method within 5 business days.' || E'\n\n' ||
    '## Post-pickup disputes (48 hours)' || E'\n' ||
    'If you accept an item at pickup and later discover it materially differs from what was described, you have **48 hours from pickup** to open a dispute through the ClovrBid app. Include photos and a short description. The operator will review and refund partially or in full at their discretion per the [Bidder Agreement](/legal/bidder-agreement).' || E'\n\n' ||
    'Disputes filed more than 48 hours after pickup are not eligible for refund.';

  v_shipping :=
    '# Shipping Policy' || E'\n\n' ||
    'This operator does not currently offer shipping. All items are pickup-only at our warehouse during posted pickup hours.';

  INSERT INTO operator_policies
    (operator_id, version, terms_md, refund_md, shipping_md,
     payment_window_hours, pickup_window_days, shipping_offered,
     refund_window_post_pickup_hours, dispute_response_hours,
     published, content_hash, created_at)
  VALUES (
    NEW.id, 1, v_terms, v_refund, v_shipping,
    -- refund_window_post_pickup_hours = 48 to match the new wording
    -- dispute_response_hours = 72 (operator SLA, L0 #3)
    0, 7, FALSE, 48, 72, TRUE,
    encode(digest(v_terms || E'\n----\n' || v_refund || E'\n----\n' || v_shipping, 'sha256'), 'hex'),
    now()
  )
  ON CONFLICT (operator_id, version) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION seed_default_operator_policy() IS
  'Seeds a default v1 published operator_policies row for newly-created '
  'operators. As of audit C6/H4 (2026-05-18), the default refund policy '
  'explicitly cites the platform 48-hour post-pickup dispute window. As of '
  'launch audit L0 #3 (2026-05-22), the seed also sets '
  'dispute_response_hours=72 so new operators inherit the standard SLA.';
