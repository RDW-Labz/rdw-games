-- 0424 — App version tables (part a): what each app's minimum / latest version
-- is, and which versions are actually running in the field.
--
-- Changes no behaviour: nothing reads app_versions and nothing calls
-- record_app_version_ping yet. The seed is the CURRENT reality with
-- min_version = latest_version, so even an app that enforced it today would
-- block nobody.
--
--   app_versions               one row per (app, platform). Public read
--                              (anon + authenticated), service_role writes.
--   app_version_pings          one row per (user, device, app, Chicago day).
--                              No client access; written only via the RPC.
--   record_app_version_ping()  SECURITY DEFINER upsert, anon + authenticated.
--
-- Read path: apps read the table directly through the SELECT policy rather
-- than through a wrapper function — one object fewer, and PostgREST can filter
-- (?app=eq.bidder&platform=eq.ios). The grant is column-level and leaves out
-- updated_by (a staff user id) so anon never sees it; clients must name the
-- columns: select('app,platform,min_version,latest_version,store_url,message,updated_at').
--
-- Locks: new tables only. Nothing touches lots / bids / invoices.

BEGIN;

-- ── app_versions ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_versions (
  app            text        NOT NULL CHECK (app IN ('bidder', 'staff')),
  platform       text        NOT NULL CHECK (platform IN ('ios', 'android')),
  min_version    text        NOT NULL CHECK (min_version ~ '^[0-9]+(\.[0-9]+){0,3}$'),
  latest_version text        NOT NULL CHECK (latest_version ~ '^[0-9]+(\.[0-9]+){0,3}$'),
  store_url      text        CHECK (store_url IS NULL OR store_url ~ '^https://'),
  message        text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  PRIMARY KEY (app, platform)
);

ALTER TABLE public.app_versions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.app_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT (app, platform, min_version, latest_version, store_url, message, updated_at)
  ON public.app_versions TO anon, authenticated;
GRANT ALL ON public.app_versions TO service_role;

DROP POLICY IF EXISTS "app_versions: public read" ON public.app_versions;
CREATE POLICY "app_versions: public read"
  ON public.app_versions
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Seed = what is in the stores today (min = latest, so nothing is blocked).
--   bidder ios     1.0.1  App Store id 6785655751 (apps/operator-web/src/lib/app-links.ts)
--   bidder android 0.1.1  Play package com.bingoauctions.bidder (same file)
--   staff  both    1.0.1  apps/field-mobile/app.config.ts `version`; staff ships
--                         via TestFlight / internal APK, so no public store URL.
INSERT INTO public.app_versions (app, platform, min_version, latest_version, store_url)
VALUES
  ('bidder', 'ios',     '1.0.1', '1.0.1', 'https://apps.apple.com/us/app/id6785655751'),
  ('bidder', 'android', '0.1.1', '0.1.1', 'https://play.google.com/store/apps/details?id=com.bingoauctions.bidder'),
  ('staff',  'ios',     '1.0.1', '1.0.1', NULL),
  ('staff',  'android', '1.0.1', '1.0.1', NULL)
ON CONFLICT (app, platform) DO NOTHING;

-- ── app_version_pings ───────────────────────────────────────────────────────
-- NULLS NOT DISTINCT so a signed-out device (user_id NULL) still gets exactly
-- one row per app per day, and the plain column list is a valid ON CONFLICT
-- target (no expression index).
CREATE TABLE IF NOT EXISTS public.app_version_pings (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         uuid        REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id       text        NOT NULL CHECK (length(device_id) BETWEEN 1 AND 64),
  app             text        NOT NULL CHECK (app IN ('bidder', 'staff')),
  platform        text        NOT NULL CHECK (platform IN ('ios', 'android')),
  day             date        NOT NULL,
  native_version  text        CHECK (length(native_version)  <= 64),
  runtime_version text        CHECK (length(runtime_version) <= 64),
  update_id       text        CHECK (length(update_id)       <= 64),
  channel         text        CHECK (length(channel)         <= 64),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_version_pings_one_per_day
    UNIQUE NULLS NOT DISTINCT (user_id, device_id, app, day)
);

CREATE INDEX IF NOT EXISTS app_version_pings_day_app_idx
  ON public.app_version_pings (day, app, platform);
CREATE INDEX IF NOT EXISTS app_version_pings_user_idx
  ON public.app_version_pings (user_id) WHERE user_id IS NOT NULL;

ALTER TABLE public.app_version_pings ENABLE ROW LEVEL SECURITY;
-- No policies: anon/authenticated get nothing. Writes go through the RPC.
REVOKE ALL ON public.app_version_pings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.app_version_pings TO service_role;

-- ── record_app_version_ping ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_app_version_ping(
  p_app             text,
  p_platform        text,
  p_device_id       text,
  p_native_version  text,
  p_runtime_version text,
  p_update_id       text,
  p_channel         text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_day date := (clock_timestamp() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  IF p_app IS NULL OR p_app NOT IN ('bidder', 'staff') THEN
    RAISE EXCEPTION 'record_app_version_ping: bad app' USING ERRCODE = '22023';
  END IF;
  IF p_platform IS NULL OR p_platform NOT IN ('ios', 'android') THEN
    RAISE EXCEPTION 'record_app_version_ping: bad platform' USING ERRCODE = '22023';
  END IF;
  IF p_device_id IS NULL OR length(btrim(p_device_id)) = 0 OR length(p_device_id) > 64 THEN
    RAISE EXCEPTION 'record_app_version_ping: bad device_id' USING ERRCODE = '22023';
  END IF;
  IF length(p_native_version) > 64 OR length(p_runtime_version) > 64
     OR length(p_update_id) > 64 OR length(p_channel) > 64 THEN
    RAISE EXCEPTION 'record_app_version_ping: value too long' USING ERRCODE = '22023';
  END IF;

  -- user_id: the caller, if signed in and still in auth.users (a stale JWT
  -- for a deleted user records as signed-out rather than failing the FK).
  INSERT INTO app_version_pings AS p (
    user_id, device_id, app, platform, day,
    native_version, runtime_version, update_id, channel,
    first_seen_at, last_seen_at
  )
  VALUES (
    (SELECT u.id FROM auth.users u WHERE u.id = auth.uid()), p_device_id, p_app, p_platform, v_day,
    p_native_version, p_runtime_version, p_update_id, p_channel,
    clock_timestamp(), clock_timestamp()
  )
  ON CONFLICT (user_id, device_id, app, day) DO UPDATE
    SET platform        = EXCLUDED.platform,
        native_version  = EXCLUDED.native_version,
        runtime_version = EXCLUDED.runtime_version,
        update_id       = EXCLUDED.update_id,
        channel         = EXCLUDED.channel,
        last_seen_at    = clock_timestamp();
END;
$func$;

REVOKE ALL ON FUNCTION public.record_app_version_ping(text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_app_version_ping(text, text, text, text, text, text, text)
  TO anon, authenticated, service_role;

COMMIT;
