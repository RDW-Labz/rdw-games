-- 0234 — close the bidder read path on the base operators table
--
-- Security-advisor follow-up, 2026-07-05. The operators_public view (0204)
-- is the intended bidder read surface, but the base table still carried the
-- pre-0204 policy operators_public_read_active (status='active' AND
-- is_bidder()), and anon/authenticated hold column-level SELECT grants —
-- verified on prod: a signed-in bidder could read stripe_account_id,
-- application_fee_bps, contact_phone, legal_name, monthly_subscription_cents,
-- settlement_hold_days straight off the base table. This is the exact
-- follow-up the 0204 header called for and was never shipped.
--
--   1. operators_public gains contact_email. On BinGo (single-operator fork
--      of ClovrBid — there is no tenant #2 by design) the operator contact
--      email is bidder-facing on purpose: it renders on every receipt and
--      pickup page as the support contact. The rest of the 0204 sensitive
--      list (stripe_*, application_fee_bps, contact_phone, legal_name, …)
--      stays OUT.
--   2. DROP the bidder base-table read policy. All four bidder-facing web
--      pages that embedded operators(...) directly are swapped to
--      operators_public(...) in the same PR; the bidder app already reads
--      the view everywhere (checked 2026-07-05). Operator staff are
--      unaffected — they read their own row via the current_operator_id()
--      policies, which remain.
--
-- The security advisor's `security_definer_view` warning on operators_public
-- remains an ACCEPTED exception (see 0204 header) — the definer setting is
-- the feature, not the bug.

BEGIN;

CREATE OR REPLACE VIEW public.operators_public
  WITH (security_invoker = false)   -- definer ON PURPOSE — see 0204 header.
AS
  SELECT
    o.id,
    o.slug,
    o.business_name,
    o.logo_url,
    o.brand_color,
    o.offers_pickup,
    o.offers_shipping,
    o.status,
    o.default_buyer_premium_bps,
    o.bid_increment_schedule,
    -- 0234: bidder-facing support contact (rendered on receipts/pickup).
    -- Fine for a single-operator platform; a future multi-tenant revival
    -- would want a dedicated support_email column instead.
    o.contact_email
  FROM public.operators AS o;

COMMENT ON VIEW public.operators_public IS
  'Public storefront projection of operators (id + branding + fulfillment '
  'flags + support contact_email) for ALL operators regardless of status. '
  'Definer view ON PURPOSE — see migration 0204 header; advisor warning is an '
  'accepted exception. Only bidder-safe columns; never add stripe_*, '
  'application_fee_bps, contact_phone, legal_name, or billing columns; never '
  'SELECT *. As of 0234 this view is the ONLY bidder read path — the base-'
  'table bidder policy was dropped.';

GRANT SELECT ON public.operators_public TO anon, authenticated;

-- Bidders now read exclusively through the view.
DROP POLICY IF EXISTS operators_public_read_active ON public.operators;

COMMIT;
