-- ============================================================================
-- 0093_default_policy_align_dispute_window.sql
--
-- Audit C6/H4 (2026-05-18): the default operator refund policy seeded by
-- migration 0091's trigger said:
--
--   "After items leave the warehouse, refunds are not available.
--    No exceptions."
--
-- That contradicted the platform-level Bidder Agreement and Terms which
-- both promise a 48-hour post-pickup dispute window. A bidder who reads
-- the operator's auto-seeded policy could reasonably believe they have no
-- recourse after walking out the door, while the legal docs say they
-- have 48 hours. Either could be used against the operator in a chargeback
-- complaint.
--
-- Fix: rewrite the default refund_md so it explicitly cites the 48-hour
-- platform dispute window and points the bidder to the in-app dispute flow.
-- Operators who want more generous terms can still update their policy via
-- /account/policies (this only touches the *default*).
--
-- Approach:
--   1. CREATE OR REPLACE the seed trigger function with the new wording
--      AND a fresh content_hash recompute (sha256 from extensions schema).
--   2. UPDATE existing operator_policies rows whose refund_md still matches
--      the old "No exceptions" wording verbatim, replacing the section
--      and bumping the content_hash. Rows that an operator has already
--      hand-edited are left alone (their refund_md no longer matches the
--      auto-seed snapshot, so the WHERE clause won't catch them).
-- ============================================================================

-- ── 1. Update the seed trigger function ────────────────────────────────────

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
     refund_window_post_pickup_hours, published, content_hash, created_at)
  VALUES (
    NEW.id, 1, v_terms, v_refund, v_shipping,
    -- refund_window_post_pickup_hours = 48 to match the new wording
    0, 7, FALSE, 48, TRUE,
    encode(digest(v_terms || E'\n----\n' || v_refund || E'\n----\n' || v_shipping, 'sha256'), 'hex'),
    now()
  )
  ON CONFLICT (operator_id, version) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ── 2. Migrate existing default-seeded rows in-place ──────────────────────
-- Only touches rows that still match the OLD "no exceptions" wording (i.e.
-- the operator hasn't customized their policy). We detect those by looking
-- for the literal "No exceptions." sentence in refund_md.
--
-- We rebuild terms_md + refund_md from scratch (so the wording is
-- byte-identical to what new operators get) and recompute content_hash.

DO $migrate$
DECLARE
  r RECORD;
  v_terms TEXT;
  v_refund TEXT;
  v_shipping TEXT;
  v_hash TEXT;
BEGIN
  FOR r IN
    SELECT op.operator_id, op.version, o.business_name
      FROM operator_policies op
      JOIN operators o ON o.id = op.operator_id
     WHERE op.refund_md LIKE '%After items leave the warehouse, refunds are not available. No exceptions.%'
       AND op.version = 1
  LOOP
    v_terms :=
      '# Operator Terms' || E'\n\n' ||
      'By placing a bid on an auction operated by ' || COALESCE(r.business_name, 'this operator') || ', you agree to these terms in addition to the [ClovrBid Terms of Service](/legal/terms) and [Bidder Agreement](/legal/bidder-agreement).' || E'\n\n' ||
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

    v_hash := encode(extensions.digest(v_terms || E'\n----\n' || v_refund || E'\n----\n' || v_shipping, 'sha256'), 'hex');

    UPDATE operator_policies
       SET terms_md     = v_terms,
           refund_md    = v_refund,
           shipping_md  = v_shipping,
           refund_window_post_pickup_hours = 48,
           content_hash = v_hash
     WHERE operator_id = r.operator_id
       AND version     = r.version;
  END LOOP;
END
$migrate$;

COMMENT ON FUNCTION seed_default_operator_policy() IS
  'Seeds a default v1 published operator_policies row for newly-created '
  'operators. As of audit C6/H4 (2026-05-18), the default refund policy '
  'explicitly cites the platform 48-hour post-pickup dispute window so '
  'operators do not inherit text that contradicts the Bidder Agreement.';
