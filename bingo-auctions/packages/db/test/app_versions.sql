-- Behavioural test for mig 0424: app_versions / app_version_pings /
-- record_app_version_ping. Plain-psql assertions, no pgTAP.
--
-- Cases:
--   1. Seed rows present, min = latest (nothing blocked).
--   2. anon can SELECT app_versions (named columns) but not updated_by,
--      and cannot INSERT / UPDATE / DELETE.
--   3. anon / authenticated cannot read or write app_version_pings directly.
--   4. Ping upsert: first call inserts one row, second call same day updates
--      last_seen_at and the version fields, still one row.
--   5. Bad inputs rejected (app, platform, device_id, >64 chars).
--   6. user_id captured from the JWT sub claim; signed-out ping has NULL user
--      and is its own row; a sub not in auth.users records as NULL.
--   7. PUBLIC has no EXECUTE on the RPC; anon and authenticated do.
--
-- Fake data only. Runs inside a transaction that is ROLLED BACK.
\set ON_ERROR_STOP on
BEGIN;

-- CI stubs auth.uid() as SELECT NULL; read the JWT sub claim the way Supabase
-- does, inside this rolled-back transaction, so case 6 can see a signed-in caller.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

INSERT INTO auth.users (id) VALUES ('f4240000-0000-0000-0000-0000000000a1')
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_fail text := '';
  v_cnt  int;
BEGIN
  SELECT count(*) INTO v_cnt FROM public.app_versions
   WHERE (app, platform, min_version, latest_version) IN (
     ('bidder', 'ios', '1.0.1', '1.0.1'),
     ('bidder', 'android', '0.1.1', '0.1.1'),
     ('staff', 'ios', '1.0.1', '1.0.1'),
     ('staff', 'android', '1.0.1', '1.0.1'));
  IF v_cnt <> 4 THEN
    v_fail := v_fail || format(E'\n  [1] expected 4 seed rows, got %s', v_cnt);
  END IF;
  IF (SELECT count(*) FROM public.app_versions) <> 4 THEN
    v_fail := v_fail || E'\n  [1] app_versions should hold exactly the 4 seed rows';
  END IF;

  IF has_function_privilege('public', 'public.record_app_version_ping(text,text,text,text,text,text,text)', 'EXECUTE') THEN
    v_fail := v_fail || E'\n  [7] PUBLIC must not have EXECUTE on record_app_version_ping';
  END IF;
  IF NOT has_function_privilege('anon', 'public.record_app_version_ping(text,text,text,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.record_app_version_ping(text,text,text,text,text,text,text)', 'EXECUTE') THEN
    v_fail := v_fail || E'\n  [7] anon and authenticated must have EXECUTE on record_app_version_ping';
  END IF;

  IF v_fail <> '' THEN RAISE EXCEPTION 'app_versions setup checks failed:%', v_fail; END IF;
END $$;

-- ── anon: read yes, write no ────────────────────────────────────────────────
SET LOCAL ROLE anon;
DO $$
DECLARE
  v_fail text := '';
  v_cnt  int;
BEGIN
  SELECT count(*) INTO v_cnt
    FROM (SELECT app, platform, min_version, latest_version, store_url, message, updated_at
            FROM public.app_versions) s;
  IF v_cnt <> 4 THEN
    v_fail := v_fail || format(E'\n  [2] anon should read 4 app_versions rows, got %s', v_cnt);
  END IF;

  BEGIN
    PERFORM updated_by FROM public.app_versions;
    v_fail := v_fail || E'\n  [2] anon must not read app_versions.updated_by';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    INSERT INTO public.app_versions (app, platform, min_version, latest_version)
    VALUES ('bidder', 'ios', '9.9.9', '9.9.9');
    v_fail := v_fail || E'\n  [2] anon INSERT into app_versions succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    UPDATE public.app_versions SET min_version = '9.9.9';
    v_fail := v_fail || E'\n  [2] anon UPDATE of app_versions succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    DELETE FROM public.app_versions;
    v_fail := v_fail || E'\n  [2] anon DELETE from app_versions succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM 1 FROM public.app_version_pings;
    v_fail := v_fail || E'\n  [3] anon SELECT on app_version_pings succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    INSERT INTO public.app_version_pings (device_id, app, platform, day)
    VALUES ('x', 'bidder', 'ios', current_date);
    v_fail := v_fail || E'\n  [3] anon INSERT into app_version_pings succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- [6] signed-out ping (no sub claim) → user_id NULL, one row after two pings
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM public.record_app_version_ping('bidder', 'ios', 'dev-anon', '1.0.1', '1.0.1', 'u-1', 'production');
  PERFORM public.record_app_version_ping('bidder', 'ios', 'dev-anon', '1.0.1', '1.0.1', 'u-2', 'production');

  -- [5] bad inputs
  BEGIN
    PERFORM public.record_app_version_ping('admin', 'ios', 'd', NULL, NULL, NULL, NULL);
    v_fail := v_fail || E'\n  [5] bad app accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.record_app_version_ping('bidder', 'web', 'd', NULL, NULL, NULL, NULL);
    v_fail := v_fail || E'\n  [5] bad platform accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.record_app_version_ping('bidder', 'ios', '   ', NULL, NULL, NULL, NULL);
    v_fail := v_fail || E'\n  [5] blank device_id accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.record_app_version_ping('bidder', 'ios', NULL, NULL, NULL, NULL, NULL);
    v_fail := v_fail || E'\n  [5] NULL device_id accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.record_app_version_ping('bidder', 'ios', repeat('d', 65), NULL, NULL, NULL, NULL);
    v_fail := v_fail || E'\n  [5] 65-char device_id accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.record_app_version_ping('bidder', 'ios', 'd', repeat('1', 65), NULL, NULL, NULL);
    v_fail := v_fail || E'\n  [5] 65-char native_version accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.record_app_version_ping('bidder', 'ios', 'd', NULL, NULL, NULL, repeat('c', 65));
    v_fail := v_fail || E'\n  [5] 65-char channel accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  IF v_fail <> '' THEN RAISE EXCEPTION 'app_versions anon checks failed:%', v_fail; END IF;
END $$;
RESET ROLE;

-- ── authenticated: JWT sub captured, upsert one row per day ─────────────────
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_fail text := '';
BEGIN
  BEGIN
    PERFORM 1 FROM public.app_version_pings;
    v_fail := v_fail || E'\n  [3] authenticated SELECT on app_version_pings succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.app_versions SET min_version = '9.9.9';
    v_fail := v_fail || E'\n  [2] authenticated UPDATE of app_versions succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  PERFORM set_config('request.jwt.claim.sub', 'f4240000-0000-0000-0000-0000000000a1', true);
  PERFORM public.record_app_version_ping('staff', 'android', 'dev-1', '1.0.1', '1.0.1', 'upd-a', 'preview');
  PERFORM pg_sleep(0.01);
  PERFORM public.record_app_version_ping('staff', 'android', 'dev-1', '1.0.1', '1.0.1', 'upd-b', 'preview');

  -- a sub with no auth.users row records as signed-out, not an FK failure
  PERFORM set_config('request.jwt.claim.sub', 'f4240000-0000-0000-0000-0000000000ff', true);
  PERFORM public.record_app_version_ping('bidder', 'android', 'dev-ghost', '0.1.1', NULL, NULL, NULL);

  IF v_fail <> '' THEN RAISE EXCEPTION 'app_versions authenticated checks failed:%', v_fail; END IF;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_fail text := '';
  v_cnt  int;
  r      record;
BEGIN
  -- [4] one row for the signed-in device, updated in place
  SELECT count(*) INTO v_cnt FROM public.app_version_pings WHERE device_id = 'dev-1';
  IF v_cnt <> 1 THEN
    v_fail := v_fail || format(E'\n  [4] dev-1 should have 1 row, got %s', v_cnt);
  END IF;
  SELECT * INTO r FROM public.app_version_pings WHERE device_id = 'dev-1';
  IF r.user_id IS DISTINCT FROM 'f4240000-0000-0000-0000-0000000000a1'::uuid THEN
    v_fail := v_fail || format(E'\n  [6] dev-1 user_id should be the JWT sub, got %s', r.user_id);
  END IF;
  IF r.update_id IS DISTINCT FROM 'upd-b' THEN
    v_fail := v_fail || format(E'\n  [4] second ping should overwrite update_id, got %s', r.update_id);
  END IF;
  IF NOT (r.last_seen_at > r.first_seen_at) THEN
    v_fail := v_fail || E'\n  [4] last_seen_at should advance past first_seen_at on the second ping';
  END IF;
  IF r.day IS DISTINCT FROM (clock_timestamp() AT TIME ZONE 'America/Chicago')::date THEN
    v_fail := v_fail || format(E'\n  [4] day should be the Chicago date, got %s', r.day);
  END IF;
  IF r.platform <> 'android' OR r.app <> 'staff' OR r.channel <> 'preview' THEN
    v_fail := v_fail || E'\n  [4] dev-1 fields not stored';
  END IF;

  -- [6] signed-out device: NULL user, still exactly one row after two pings
  SELECT count(*) INTO v_cnt FROM public.app_version_pings
   WHERE device_id = 'dev-anon' AND user_id IS NULL;
  IF v_cnt <> 1 THEN
    v_fail := v_fail || format(E'\n  [6] dev-anon should have 1 NULL-user row, got %s', v_cnt);
  END IF;
  SELECT count(*) INTO v_cnt FROM public.app_version_pings
   WHERE device_id = 'dev-ghost' AND user_id IS NULL;
  IF v_cnt <> 1 THEN
    v_fail := v_fail || E'\n  [6] unknown sub should record as a NULL-user row';
  END IF;

  -- [5] nothing written by the rejected calls
  SELECT count(*) INTO v_cnt FROM public.app_version_pings;
  IF v_cnt <> 3 THEN
    v_fail := v_fail || format(E'\n  [5] expected 3 ping rows total, got %s', v_cnt);
  END IF;

  IF v_fail <> '' THEN RAISE EXCEPTION 'app_versions ping checks failed:%', v_fail; END IF;
  RAISE NOTICE 'app_versions: all checks passed';
END $$;

ROLLBACK;
