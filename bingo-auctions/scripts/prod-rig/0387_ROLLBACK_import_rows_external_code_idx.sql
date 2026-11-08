-- STANDBY ONLY, never merge. Rollback for 0387: drops the index it added.
-- Rig-tested 2026-10-06.
-- Apply: gh workflow run apply-migration.yml --ref braden/rollback-0382-0387-standby -f mode=rerun -f file=0387_ROLLBACK_import_rows_external_code_idx.sql
DROP INDEX IF EXISTS public.import_rows_external_code_idx;
