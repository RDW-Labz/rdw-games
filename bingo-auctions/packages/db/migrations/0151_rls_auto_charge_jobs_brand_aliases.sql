-- 0151 — Enable RLS on auto_charge_jobs + brand_aliases (Supabase advisory fix)
-- (Renumbered 0150 → 0151 on 2026-05-27: the parallel session committed
--  0150_resolve_lot_by_sticker.sql, so this security fix moved to 0151 to avoid a
--  duplicate-0150 collision.)
--
-- WHY: the Supabase security linter flagged `rls_disabled_in_public` on prod
-- project xgsujdzicnjenhqihovk (advisory dated 2026-05-25). Two public-schema
-- tables had Row-Level Security OFF with full anon/authenticated grants (from
-- Supabase's default privileges), so the public anon key could read / insert /
-- update / delete them via PostgREST:
--   - auto_charge_jobs (0105): the off-session payment-charge queue (CRITICAL —
--     invoice_id, bidder_id, amounts, attempt counts).
--   - brand_aliases   (0040): global brand-normalization reference data.
-- The core-table RLS discipline (0002 / 0028 / 0091 / 0094 / 0133) never covered
-- these two. Confirmed live 2026-05-27: anon GET returned HTTP 200 (open).
--
-- APPLIED DIRECTLY TO PROD 2026-05-27 via the Supabase Management API to close
-- the hole immediately; this migration codifies it so a DB rebuild can't regress.
-- Idempotent — safe to (re-)run through the migration runner.
--
-- SAFE because:
--   - auto_charge_jobs is written ONLY by the SECURITY DEFINER invoice trigger
--     (trigger_enqueue_auto_charge, 0105) and drained by the service-role worker
--     (/api/cron/auto-charge-drain) — both bypass RLS. No client path touches it.
--     Deny-all (RLS on, no policy) is correct, matching the other worker queues
--     (notifications_outbox / build_invoice_jobs / product_cache_warm_jobs).
--   - brand_aliases is read by extract_brand() (SECURITY INVOKER, 0040), so
--     authenticated callers need a SELECT policy. It's global, non-sensitive
--     reference data, so `USING (true)` for authenticated is correct. service_role
--     bypasses RLS; anon loses all access.

BEGIN;

-- auto_charge_jobs — service-role / DEFINER-trigger only; deny all client access.
ALTER TABLE public.auto_charge_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auto_charge_jobs FROM anon, authenticated;

-- brand_aliases — authenticated read (reference data), no client writes.
ALTER TABLE public.brand_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.brand_aliases FROM anon, authenticated;
GRANT SELECT ON public.brand_aliases TO authenticated;
DROP POLICY IF EXISTS brand_aliases_read ON public.brand_aliases;
CREATE POLICY brand_aliases_read ON public.brand_aliases
  FOR SELECT TO authenticated USING (true);

COMMIT;
