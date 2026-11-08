-- 0440 — revoke the unused anon/authenticated grants on 18 RLS-locked tables
-- (defence in depth, follow-up to the #499 advisor audit).
--
-- WHY (read-only prod scan 2026-10-21): these public tables have RLS ON and
-- ZERO policies, but still carry the Supabase default grants (SELECT, INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER) to anon and authenticated.
-- Today RLS default-deny makes every anon/authenticated read return 0 rows,
-- so nothing is exposed. The grants are a second lock left open: one stray
-- permissive policy, or RLS being switched off, and the table is public.
--
-- PROOF NOTHING USES THEM AS anon/authenticated (2026-10-21):
--   (a) apps: every supabase.from() on these tables is getSupabaseAdmin()
--       (service_role) in operator-web; the bidder and staff apps only POST to
--       /api/telemetry/crash and /api/telemetry/share-click, server routes that
--       write with service_role. No PostgREST embeds of these tables.
--   (b) prod catalog: no SECURITY INVOKER function in any schema mentions any
--       of these tables (pg_get_functiondef substring match), so no RPC or
--       trigger running as anon/authenticated touches them.
--   (c) the only view over any of them (stuck_webhook_claims) is not granted
--       to anon or authenticated; no RLS policy on another table reads them.
--   (d) no invoker trigger on another table writes into them (same as (b)).
--
-- WHAT: REVOKE ALL from anon and authenticated. service_role and the owner
-- (postgres) are untouched. No data change, no RLS change (already on).
-- After this, an anon/authenticated read raises 42501 instead of returning
-- 0 rows.
-- CI replay: every listed table is created by an earlier migration (0033..0413).
-- LOCKS: REVOKE takes a brief lock on each listed table only; none of
-- lots/bids/invoices. lock_timeout 3s.
-- ROLLBACK: scripts/prod-rig/0440_ROLLBACK_tighten_public_grants.sql.
SET lock_timeout = '3s';

-- Plain statements (no DO/EXECUTE, so the guard lint can analyse them). All
-- 18 tables are created by earlier migrations, so this also runs on an empty CI replay.
REVOKE ALL ON TABLE
  public._schema_migrations,
  public.bidder_sticker_scan_log,
  public.build_invoice_jobs,
  public.client_crash_reports,
  public.image_enrichment_jobs,
  public.invariant_check_runs,
  public.marketing_campaign_sends,
  public.marketing_digest_sends,
  public.meta_events_outbox,
  public.ops_alert_throttle,
  public.ota_publishes,
  public.platform_settings,
  public.processed_webhook_events,
  public.product_cache_warm_jobs,
  public.promo_codes,
  public.refund_claims,
  public.share_clicks,
  public.workers
FROM anon, authenticated;
