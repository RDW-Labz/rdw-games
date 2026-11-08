-- 0152 — Lock down 7 SECURITY DEFINER views (Supabase advisor: security_definer_view)
-- (Renumbered 0151 → 0152 on 2026-05-27, paired with 0151_rls_… — see that file.)
--
-- WHY: the Supabase security advisor flagged 7 public views defined SECURITY
-- DEFINER, and they had anon + authenticated SELECT grants. SECURITY DEFINER views
-- BYPASS RLS, so the public anon key could read EVERY operator's data cross-tenant.
-- Confirmed live 2026-05-27: anon GET operator_billing_mtd / operator_ai_usage_mtd /
-- invoice_timeline all returned HTTP 200 with other operators' rows. SEV-1 tenant
-- isolation breach.
--
-- FIX (applied directly to prod 2026-05-27 via the Management API to stop the leak;
-- codified here so a rebuild can't regress — idempotent):
--   1. Flip every view to `security_invoker = true` so it runs with the CALLER's
--      privileges + RLS (an authenticated operator sees only their own rows; anon
--      sees nothing). Clears the security_definer_view advisor.
--   2. REVOKE anon on all 7 (no anonymous use of operator billing / usage / timelines).
--   3. REVOKE authenticated on stuck_webhook_claims (super-admin/service-role only).
--
-- SAFE: the operator dashboard reads these via getSupabaseAdmin() (service_role,
-- which bypasses RLS) with an explicit operator_id filter (e.g. billing/page.tsx:136),
-- so security_invoker does not blank it. stuck_webhook_claims is read via the admin
-- client on super-admin ops/health pages only.
--
-- NOTE: if any of these views is later recreated via CREATE OR REPLACE VIEW, include
-- `WITH (security_invoker = true)` in that statement so the setting isn't lost (this
-- 0151 migration re-applies it on a full rebuild regardless).

BEGIN;

ALTER VIEW public.operator_billing_mtd        SET (security_invoker = true);
ALTER VIEW public.operator_ai_usage_mtd       SET (security_invoker = true);
ALTER VIEW public.walk_progress_per_warehouse SET (security_invoker = true);
ALTER VIEW public.invoice_timeline            SET (security_invoker = true);
ALTER VIEW public.lot_timeline                SET (security_invoker = true);
ALTER VIEW public.auction_timeline            SET (security_invoker = true);
ALTER VIEW public.stuck_webhook_claims        SET (security_invoker = true);

REVOKE ALL ON public.operator_billing_mtd, public.operator_ai_usage_mtd,
  public.invoice_timeline, public.lot_timeline, public.auction_timeline,
  public.walk_progress_per_warehouse, public.stuck_webhook_claims FROM anon;

REVOKE ALL ON public.stuck_webhook_claims FROM authenticated;

COMMIT;
