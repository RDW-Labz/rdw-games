-- 0215 — client crash telemetry + ops alert throttle
--
-- Layer-1 crash telemetry (launch hardening, 2026-07-03): both mobile apps'
-- Sentry libs are NO-OP stubs (native SDK removed 2026-05-20 over the iOS 26
-- launch-hang), so production JS crashes are invisible — the pickup-push crash
-- was only found because one tester filed an Apple report. The apps now catch
-- fatal JS errors with a global handler and POST them to
-- /api/telemetry/crash, which writes here via the service-role client.
--
-- ops_alert_throttle backs the health-check cron's new email alerts (Resend →
-- OPS_ALERT_EMAIL): one row per check, so an ongoing incident emails at most
-- once per hour instead of every 5-minute cron tick.

BEGIN;

CREATE TABLE IF NOT EXISTS public.client_crash_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app         TEXT NOT NULL CHECK (app IN ('bidder', 'staff')),
  platform    TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  app_version TEXT,
  ota_update  TEXT,
  message     TEXT NOT NULL,
  stack       TEXT,
  screen      TEXT,
  is_fatal    BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Service-role writes only (the API route inserts with the admin client after
-- capping sizes). RLS on with no policies = no anon/authenticated access.
ALTER TABLE public.client_crash_reports ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS client_crash_reports_created_idx
  ON public.client_crash_reports (created_at DESC);

COMMENT ON TABLE public.client_crash_reports IS
  '0215: fatal JS errors reported by the mobile apps'' global error handler '
  'via POST /api/telemetry/crash. Watched by the health-check cron (spike '
  'alert) and the ops dashboard.';

CREATE TABLE IF NOT EXISTS public.ops_alert_throttle (
  check_name      TEXT PRIMARY KEY,
  last_emailed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ops_alert_throttle ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.ops_alert_throttle IS
  '0215: per-check email throttle for health-check ops alerts — an ongoing '
  'incident emails at most once per hour, not every cron tick.';

COMMIT;
