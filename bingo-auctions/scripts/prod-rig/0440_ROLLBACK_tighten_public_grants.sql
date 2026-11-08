-- ROLLBACK for 0440_tighten_public_grants.sql. Run only if 0440 broke something.
--
-- Restores exactly what anon and authenticated held before 0440, read from
-- prod pg_class.relacl (aclexplode) on 2026-10-21, PostgreSQL 17.6. All 18
-- tables were identical: the 8 table privileges below, for both roles, no
-- column-level grants, no WITH GRANT OPTION. Written out per table, not as
-- GRANT ALL, so it states the exact pre-0440 set.
-- RLS stays on (0440 did not touch it), so reads go back to returning 0 rows.
-- A missing table is skipped.
SET lock_timeout = '3s';

DO $$
DECLARE
  t text;
  n int := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    '_schema_migrations',
    'bidder_sticker_scan_log',
    'build_invoice_jobs',
    'client_crash_reports',
    'image_enrichment_jobs',
    'invariant_check_runs',
    'marketing_campaign_sends',
    'marketing_digest_sends',
    'meta_events_outbox',
    'ops_alert_throttle',
    'ota_publishes',
    'platform_settings',
    'processed_webhook_events',
    'product_cache_warm_jobs',
    'promo_codes',
    'refund_claims',
    'share_clicks',
    'workers'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '0440 rollback: public.% not here, skipping', t;
      CONTINUE;
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.%I TO anon, authenticated', t);
    n := n + 1;
  END LOOP;
  RAISE NOTICE '0440 rollback: pre-0440 grants restored on % table(s)', n;
END
$$;
