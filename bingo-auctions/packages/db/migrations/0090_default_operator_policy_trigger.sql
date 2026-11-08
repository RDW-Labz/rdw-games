-- ============================================================================
-- 0090_default_operator_policy_trigger.sql
--
-- Migration 0088 (operator_policies) seeded a default v1 published policy
-- for every existing operator at migration-apply time. But operators created
-- LATER (after the migration ran) get no policy seeded, which means a fresh
-- bidder can't bid on their auctions (the per-operator acceptance modal
-- has nothing to fetch from get_active_operator_policy).
--
-- Caught by mega-sim: a brand-new SIM operator had operator_policies count = 0.
--
-- Fix: AFTER INSERT trigger on operators that seeds the same v1 default
-- policy the 0088 migration body did. Idempotent via ON CONFLICT.
-- ============================================================================

CREATE OR REPLACE FUNCTION seed_default_operator_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO operator_policies
    (operator_id, version, terms_md, refund_md, shipping_md,
     payment_window_hours, pickup_window_days, shipping_offered,
     refund_window_post_pickup_hours, published, content_hash, created_at)
  VALUES (
    NEW.id, 1,
    '# Operator Terms

By placing a bid on an auction operated by ' || COALESCE(NEW.business_name, 'this operator') || ', you agree to these terms in addition to the [ClovrBid Terms of Service](/legal/terms) and [Bidder Agreement](/legal/bidder-agreement).

## Payment
Payment is due immediately on winning. Your saved payment method will be charged at auction close.

## Pickup window
You have 7 days from auction close to pick up your won items.

## Inspection
You may inspect items at the pickup counter before accepting them. Refunds for damaged or misdescribed items are issued at the pickup counter only.

## All sales final after pickup
Once items leave our warehouse with you, all sales are final. No returns, no refunds.

## Suspension for non-payment / no-show
Repeated payment failures or pickup no-shows may result in suspension from bidding with this operator.',
    '# Refund Policy

Refunds are issued at the pickup counter for items that materially differ from the listing description, or that are damaged in a way not disclosed in the listing.

To request a refund, decline the item at pickup and present it to the pickup attendant. We will issue a refund to your original payment method within 5 business days.

After items leave the warehouse, refunds are not available. No exceptions.',
    '# Shipping Policy

This operator does not currently offer shipping. All items are pickup-only at our warehouse during posted pickup hours.',
    0, 7, FALSE, 0, TRUE, 'seed-default-v1', now()
  )
  ON CONFLICT (operator_id, version) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operators_seed_default_policy ON operators;
CREATE TRIGGER operators_seed_default_policy
  AFTER INSERT ON operators
  FOR EACH ROW
  EXECUTE FUNCTION seed_default_operator_policy();

COMMENT ON FUNCTION seed_default_operator_policy() IS
  'Seeds a default v1 published operator_policies row for newly-created '
  'operators. Mirrors the seed in migration 0088 (which only ran for '
  'pre-existing operators). Trigger source: caught by mega-sim 2026-05-18 '
  'when a freshly-created SIM operator had no policies and the bidder '
  'acceptance modal had nothing to render.';
