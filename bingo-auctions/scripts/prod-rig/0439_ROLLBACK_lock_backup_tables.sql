-- ROLLBACK for 0439: restore the pre-0439 state exactly as read from prod on
-- 2026-10-21 (RLS off; Supabase default ALL privileges for anon/authenticated).
-- NOTE: this re-opens public read access to the backup tables. Use only if 0439
-- broke something. To run: copy into packages/db/migrations on a never-merge
-- standby branch, then apply-migration.yml mode=rerun --ref <standby>.
SET lock_timeout = '3s';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['_catalog_misfire_20260921', '_manifest_rows_already_lotted_20260928', '_poisoned_tracking_lookups_20260924'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO anon, authenticated', t);
  END LOOP;
END
$$;
