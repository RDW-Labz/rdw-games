-- 0379 — BinGo seller policy version 2: the withdrawn-lots clause.
--
-- Same clause as Bidder Agreement §3.5 (0378). The seller policy is the one
-- document bidders accept again when it changes: the bidder app shows its
-- seller-terms box whenever the latest published operator_policies version
-- hasn't been accepted (apps/bidder-app/app/lot/[id].tsx), and the website
-- does the same once its seller-policy gate ships. So publishing this makes
-- every app bidder accept the new terms before their next bid on BinGo.
--
-- Copies BinGo's latest published version with every setting unchanged, adds a
-- "## Withdrawn lots" section to terms_md, and publishes it as the next
-- version. content_hash uses the admin Policies page's scheme
-- (sha256 of terms_md, "\n---\n", refund_md, "\n---\n", shipping_md; see
-- (operator)/account/policies/actions.ts). Idempotent: skipped when the latest
-- version already carries the clause. BinGo only; the demo operator's policy
-- is untouched.
--
-- WINDOW: customer-facing (every app bidder is prompted at their next bid).
-- 09:00-16:00, never 18:00-22:00.
--
-- Rollback: UPDATE operator_policies SET published = false
--           WHERE operator_id = '05775af4-adb7-4f0f-943e-94a91e17f60d'
--             AND version = <the version this inserted>;
--   (the app then falls back to the previous published version)

INSERT INTO public.operator_policies (
  operator_id, version, terms_md, refund_md, shipping_md,
  payment_window_hours, pickup_window_days, shipping_offered,
  refund_window_post_pickup_hours, effective_at, published, content_hash,
  created_by, created_at, dispute_response_hours, no_show_policy,
  restock_fee_cents, relist_fee_cents, admin_can_refund_outside_window,
  require_identity_check, identity_check_threshold_cents, require_signature,
  allow_bidder_disputes)
SELECT p.operator_id, p.version + 1, t.terms_md, p.refund_md, p.shipping_md,
       p.payment_window_hours, p.pickup_window_days, p.shipping_offered,
       p.refund_window_post_pickup_hours, now(), true,
       encode(extensions.digest(t.terms_md || E'\n---\n' || p.refund_md || E'\n---\n' || p.shipping_md, 'sha256'), 'hex'),
       NULL, now(), p.dispute_response_hours, p.no_show_policy,
       p.restock_fee_cents, p.relist_fee_cents, p.admin_can_refund_outside_window,
       p.require_identity_check, p.identity_check_threshold_cents, p.require_signature,
       p.allow_bidder_disputes
FROM (
  SELECT * FROM public.operator_policies
  WHERE operator_id = '05775af4-adb7-4f0f-943e-94a91e17f60d' AND published
  ORDER BY version DESC LIMIT 1
) p
CROSS JOIN LATERAL (
  SELECT rtrim(p.terms_md, E'\n') || E'\n\n## Withdrawn lots\n'
    || 'BinGo may withdraw a lot before it closes. Bids on a withdrawn lot are void and no one is charged. '
    || 'If a withdrawn lot was already paid for, it''s refunded in full.' || E'\n' AS terms_md
) t
WHERE position('## Withdrawn lots' IN p.terms_md) = 0;
