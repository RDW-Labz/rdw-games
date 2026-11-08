-- 0413 — OTA publish log for ops health-check context
--
-- Written by .github/workflows/eas-update.yml after each real (non-dry-run)
-- eas update / republish so the hourly silent-exit email can say when a staff
-- or customer app update went out.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ota_publishes (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app          TEXT NOT NULL CHECK (app IN ('bidder', 'staff')),
  branch       TEXT NOT NULL,
  group_id     TEXT,
  update_ids   TEXT[] NOT NULL DEFAULT '{}',
  message      TEXT,
  gh_run_id    TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ota_publishes_published_at_idx
  ON public.ota_publishes (published_at DESC);

ALTER TABLE public.ota_publishes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.ota_publishes IS
  '0413: one row per EAS Update publish/republish (eas-update.yml, non-dry-run). '
  'Service-role only — lets the health-check cron correlate silent exits with '
  'recent staff/customer OTA publishes.';

COMMIT;
