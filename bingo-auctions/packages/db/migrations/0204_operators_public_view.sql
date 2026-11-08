-- ============================================================================
-- Migration 0204 — operators_public: a safe public projection of operators
--                  (OP-VIS-DEFENSE, Option B)
--
-- THE BUG THIS FIXES
-- ------------------
-- The bidder app embeds operator branding on every lot/auction/invoice it
-- renders, e.g. lots.select('..., operators(business_name, logo_url,
-- brand_color)'). That embed resolves against the base `operators` table under
-- the bidder's RLS, whose only bidder-facing policy is:
--
--     operators_public_read_active: USING (status = 'active' AND is_bidder())
--
-- So the moment an operator's status is anything but 'active' (pending, while
-- onboarding; suspended; paused), the embedded operators object comes back
-- NULL — and the apps then DROP those rows on the client
-- (`.filter(l => l.operators != null)`, bidder index.tsx:460/537). Result: a
-- brand-new or paused operator's live/scheduled lots silently vanish from the
-- bidder app even though the auction is real and biddable. The operator "goes
-- dark." This is the footgun for operator #2 and every future operator during
-- the onboarding window.
--
-- THE FIX
-- -------
-- A view that exposes ONLY public storefront columns for EVERY operator,
-- independent of status. The apps embed this view instead of the base table:
--     operators:operators_public(business_name, logo_url, brand_color)
-- (the `operators:` alias keeps the JSON key `operators`, so app row types are
-- unchanged). A row now resolves for pending/suspended operators too, so their
-- lots stop being dropped.
--
-- WHY security_invoker = false (definer) — AND WHY THIS IS NOT THE 0152 BREACH
-- ---------------------------------------------------------------------------
-- A view's SELECT list fixes the exposed columns REGARDLESS of the
-- security_invoker setting. We make this view run with the owner's privileges
-- (security_invoker = false) so it bypasses the base-table RLS and returns
-- public columns for operators of ANY status — that is the whole point.
--
-- The 2026-05-27 SEV-1 (migration 0152) was the OPPOSITE situation: SECURITY
-- DEFINER views over operator_billing_mtd / operator_ai_usage_mtd /
-- invoice_timeline exposed SENSITIVE, cross-tenant data (revenue, AI spend,
-- per-invoice history) to the anon key. Those were flipped to
-- security_invoker = true precisely because their columns were private.
--
-- operators_public is the deliberate inverse: its columns are PUBLIC by design.
-- business_name / logo_url / brand_color / offers_pickup / offers_shipping are
-- already rendered to anonymous visitors on the public website
-- (clovrbid.com/lot/{code}, served via the service-role admin client). There is
-- nothing tenant-private here, so exposing them cross-operator is not a leak —
-- it is a public business directory, which is what a bidder marketplace is.
--
-- Crucially, the base `operators` table RLS is LEFT UNTOUCHED by this
-- migration. We do NOT broaden any base-table policy, so this change adds NO
-- new way to read the base table's sensitive columns (stripe_account_id,
-- application_fee_bps, contact_*, pro_stripe_*, …). The only new read path is
-- this column-restricted view.
--
-- The Supabase security advisor WILL flag this as `security_definer_view`. That
-- is an accepted, documented false-positive for this one view: it is a public
-- projection on purpose. DO NOT "fix" the advisor by flipping it to
-- security_invoker = true — that silently re-introduces the status='active'
-- gate and brings the go-dark bug right back.
--
-- HARD RULES FOR THIS VIEW (enforced by review + test 0204):
--   • NEVER add a column that is not safe for the whole public to read.
--   • NEVER use SELECT * here — list every column explicitly so a new
--     sensitive column on `operators` cannot leak in by accident.
--   • Sensitive columns that MUST NEVER appear here: stripe_account_id,
--     stripe_onboarding_*, charges_enabled, monthly_subscription_cents,
--     application_fee_bps (the PLATFORM's private cut — distinct from
--     default_buyer_premium_bps, which IS public and is exposed here),
--     pro_stripe_*, settlement_hold_days, legal_name, contact_email,
--     contact_phone.
--
-- FOLLOW-UP (separate, deliberate hardening — NOT in this migration):
--   Once all shipped bidder builds read the view, tighten/replace
--   operators_public_read_active on the BASE table so bidders can no longer
--   read base-table operator columns directly at all (closes the pre-existing
--   active-operator column exposure). Gated on app adoption to avoid breaking
--   older TestFlight builds still embedding operators(...) directly.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.operators_public
  WITH (security_invoker = false)   -- definer: expose public columns for ALL
                                    -- operators regardless of status. See header.
AS
  SELECT
    o.id,
    o.slug,
    o.business_name,
    o.logo_url,
    o.brand_color,
    o.offers_pickup,
    o.offers_shipping,
    o.status,                      -- subscription screen reads operator status
    o.default_buyer_premium_bps,   -- buyer's premium the BIDDER pays (public; already
                                   -- shown on clovrbid.com/lot). NOT application_fee_bps,
                                   -- which is the platform's private cut and stays OUT.
    o.bid_increment_schedule       -- operator default bid steps; bidder needs them to bid
  FROM public.operators AS o;

COMMENT ON VIEW public.operators_public IS
  'Public storefront projection of operators (id + branding + fulfillment flags) '
  'for ALL operators regardless of status. Definer view ON PURPOSE so pending/'
  'suspended operators with live content still render in the bidder app — see '
  'migration 0204 header. Only public-safe columns; never add sensitive columns, '
  'never SELECT *. Do NOT flip to security_invoker=true (re-breaks visibility).';

-- Public directory: readable pre-login (anon, for browse) and by signed-in
-- bidders (authenticated). No INSERT/UPDATE/DELETE — it is a read projection.
GRANT SELECT ON public.operators_public TO anon, authenticated;

COMMIT;
